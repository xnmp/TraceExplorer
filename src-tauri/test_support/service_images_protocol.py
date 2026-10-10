#!/usr/bin/env python3
"""Actual Trace executable + framed fake host; no installed app or provider IO."""
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

BINARY = Path(sys.argv[1])
PNG = (Path(__file__).parent / 'fixtures/source32.png').read_bytes()
OP = 'ab' * 16
D = {'handle': 'c' * 48, 'sha256': hashlib.sha256(PNG).hexdigest(), 'byteLength': len(PNG), 'mediaType': 'image/png'}
PROOF = 'e' * 48

class Host:
    def __init__(self, root, unavailable=False):
        self.root = root
        self.db = root / 'trace.sqlite'
        self.path = root / 'sealed-provider-output.png'
        self.path.write_bytes(PNG)
        self.receipt = None
        self.unavailable = unavailable
        self.calls = []
    def link(self):
        with sqlite3.connect(self.db) as c:
            return json.loads(c.execute('SELECT body FROM image_service_operations WHERE operation_id=?', (OP,)).fetchone()[0])
    def handle(self, frame):
        method, p = frame['method'], frame.get('params', {})
        if method == 'host.services.invoke':
            assert p['packageId'] == 'xnmp.image-generation'
            method, p = p['method'], p['params']
        self.calls.append(method)
        if method == 'host.services.describe':
            return {'version': 1, 'available': True, 'providerDigest': 'b' * 64}
        if method == 'describe':
            return {'version': 1, 'profiles': []}
        if method == 'prepare':
            options = {key: p['options'][key] for key in ('size', 'resolution', 'aspectRatio', 'quality', 'background')}
            recipe = dict(schemaVersion=1, formatterVersion=1, connectionId=p['connectionId'], connectionRevision=p['expectedConnectionRevision'], adapter='openai-images', endpointIdentity='https://example.invalid/v1', model=p['model'], options=options, inputDigests=[], inputRoles=[], submittedPrompt=p['prompt'], agentTask=None)
            fingerprint = hashlib.sha256(json.dumps(recipe, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
            return {'preparationToken': 'fixture-token', 'effectiveRecipe': recipe, 'effectiveRecipeDigest': fingerprint}
        if method == 'start':
            link = self.link()
            assert link['phase'] == 'forwarding'
            assert (self.root / '.image-service-initialized').read_bytes() == b'TEIC1\n'
            recipe = link['recipe']
            metadata = dict(adapter=recipe['adapter'], endpointIdentity=recipe['endpointIdentity'], requestedModel=recipe['model'], actualModel=recipe['model'], externalRequestId='fixture-native-request', threadId=None, options=recipe['options'], remoteChargeUncertain=False)
            self.receipt = dict(version=1, operationId=OP, requestFingerprint=p['effectiveRecipeDigest'], provider={'packageId': 'xnmp.image-generation', 'serviceId': 'image-generation', 'major': 1}, revision=1, execution={'state': 'succeeded', 'metadata': metadata}, delivery={'state': 'unavailable', 'reason': 'Fixture delivery interrupted'} if self.unavailable else {'state': 'available', 'output': D})
            return self.receipt
        if method in ('status', 'cancel'):
            assert self.receipt is not None
            return self.receipt
        if method == 'host.artifacts.read':
            assert p['artifact'] == D
            return {'path': str(self.path), 'artifact': D}
        if method == 'host.artifacts.acquired':
            evidence = Path(p['evidencePath'])
            assert evidence.read_bytes() == PNG
            assert evidence.is_relative_to(self.root / 'generated')
            with sqlite3.connect(self.db) as c:
                anchor = c.execute('SELECT prepared_anchor_path FROM runs WHERE id=?', (self.link()['runId'],)).fetchone()[0]
            assert evidence.stat().st_ino == Path(anchor).stat().st_ino
            return {'transferReceipt': PROOF}
        if method == 'acknowledge':
            assert self.link()['transferReceipt'] == PROOF
            assert p['transferReceipt'] == PROOF and p['outputSha256'] == D['sha256']
            self.receipt['revision'] += 1
            self.receipt['delivery'] = {'state': 'acquired', 'transferReceipt': PROOF}
            return self.receipt
        if method == 'host.artifacts.release':
            return {'released': True}
        raise AssertionError(f'Unexpected reverse call {method}')

class Backend:
    def __init__(self, host):
        self.host = host
        self.events = []
        self.sequence = 0
        self.process = subprocess.Popen([str(BINARY), '--data-dir', str(host.root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.frames = queue.Queue()
        def read():
            for line in self.process.stdout:
                self.frames.put(json.loads(line))
        threading.Thread(target=read, daemon=True).start()
    def send(self, frame):
        self.process.stdin.write(json.dumps(frame) + '\n')
        self.process.stdin.flush()
    def next(self):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            frame = self.frames.get(timeout=max(0.01, deadline-time.monotonic()))
            if frame.get('method', '').startswith('host.'):
                result = self.host.handle(frame)
                self.send({'jsonrpc': '2.0', 'id': frame['id'], 'result': result})
            elif frame.get('method') == 'event':
                self.events.append(frame['params'])
            else:
                return frame
        raise AssertionError('Backend frame timeout')
    def call(self, method, params):
        self.sequence += 1
        self.send({'jsonrpc': '2.0', 'id': self.sequence, 'method': method, 'params': params})
        frame = self.next()
        assert frame['id'] == self.sequence, frame
        assert 'error' not in frame, frame
        return frame['result']
    def ready(self):
        assert self.call('initialize', {'protocolVersion': 1, 'activeRunIds': [], 'deferRecovery': True, 'serviceService': {'version': 1}, 'artifactService': {'version': 1}})['ready'] is False
        assert self.call('lifecycle.activate', {})['ready'] is True
    def settle(self, expected):
        for _ in range(30):
            value = self.call('jobs.status', {'operationId': OP})
            if value and value.get('recoveryState') == expected:
                return value
            time.sleep(.02)
        raise AssertionError(value)
    def close(self):
        os.killpg(self.process.pid, signal.SIGKILL)
        self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stdin.close()
        self.process.stderr.close()

def scenario(unavailable):
    with tempfile.TemporaryDirectory(prefix='trace-image-native-') as name:
        # The real host returns paths under its canonicalized store root; macOS
        # temp dirs sit behind the /var -> /private/var alias.
        root = Path(name).resolve()
        host = Host(root, unavailable)
        backend = Backend(host)
        try:
            backend.ready()
            request = dict(connectionId='fixture', expectedConnectionRevision='recipe-1', model='arbitrary-image', sourcePath=None, prompt='Draw a fixture image', outputDir=str(root), outputFilename='image.png', size='1024x1024', quality='auto', background='auto')
            assert backend.call('jobs.start', {'kind': 'openai-image', 'jobId': 9, 'operationId': OP, 'request': request}) == 9
            if unavailable:
                value = backend.settle('needs_attention')
                assert value['status'] == 'uncertain' and value['providerExecution']['state'] == 'succeeded'
                backend.close()
                host.receipt['revision'] += 1
                host.receipt['delivery'] = {'state': 'available', 'output': D}
                backend = Backend(host)
                backend.ready()
            value = backend.settle('succeeded')
            assert Path(value['outputPath']).read_bytes() == PNG
            assert host.calls.count('start') == 1
            assert host.calls.index('host.artifacts.acquired') < host.calls.index('acknowledge')
            assert backend.call('jobs.start', {'kind': 'openai-image', 'jobId': 10, 'operationId': OP, 'request': request}) == 9
            assert host.calls.count('start') == 1
            with sqlite3.connect(host.db) as c:
                assert c.execute('SELECT COUNT(*) FROM artifacts WHERE generating_run=?', (value['runId'],)).fetchone()[0] == 1
            print('PASS actual-native-stdio ' + ('restart-delivery-restoration' if unavailable else 'sealed-png-acquisition'))
        finally:
            backend.close()

scenario(False)
scenario(True)
