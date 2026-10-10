#!/usr/bin/env python3
"""Actual Trace backend + actual Image Generation provider + host-shaped broker.

Usage: shared_ai_end_to_end.py <trace-backend> <image-generation-backend> [scenario...]

The broker stands in for Tauri Explorer and keeps its documented contracts:
capture snapshots each input's bytes into an immutable store before any
provider sees them, artifacts move between plugins only as store paths, and
every JSON-RPC line obeys the 1 MiB frame bound. The image endpoint is a
loopback HTTP server and the Codex CLI is a host.process.run fixture that never
executes anything. No credentials, real HOME or paid provider is used.
"""
import base64
import hashlib
import http.server
import itertools
import json
import os
from pathlib import Path
import queue
import secrets
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import zlib

TRACE = Path(sys.argv[1]).resolve()
PROVIDER = Path(sys.argv[2]).resolve()
SCENARIOS = sys.argv[3:] or ['ordered-large-http', 'profile-change', 'provider-restart', 'cli-task']
FRAME = 1024 * 1024
PACKAGE = 'xnmp.image-generation'
CALLER = {'packageId': 'xnmp.trace-explorer', 'packageDigest': 'd' * 64, 'incarnation': 1}
SECRET_VARIABLES = ('OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ANTHROPIC_API_KEY')


def png(width, height):
    """An RGB PNG of random pixels: zlib cannot shrink it below its raw size."""
    rows = b''.join(b'\x00' + os.urandom(width * 3) for _ in range(height))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    header = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')


def dimensions(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
        raise Failure('invalid_request', 'Fixture capture accepts PNG inputs only')
    return struct.unpack('>II', data[16:24])


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Failure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


class Peer:
    """One stdio JSON-RPC peer. Every line in either direction is recorded so
    the frame bound can be asserted; reverse requests are served on threads so a
    forwarded call can wait while the other plugin calls back into the host."""

    def __init__(self, name, argv, serve, env):
        self.name, self.serve = name, serve
        self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=env)
        self.write_lock = threading.Lock()
        self.ids = itertools.count(1)
        self.pending = {}
        self.lines = []
        self.errors = []
        self.stderr = []
        threading.Thread(target=self.read, daemon=True).start()
        threading.Thread(target=lambda: self.stderr.extend(self.process.stderr), daemon=True).start()

    def write(self, value):
        line = json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()
        self.write_raw(line)

    def write_raw(self, line):
        with self.write_lock:
            self.lines.append(('to', line))
            self.process.stdin.write(line + b'\n')
            self.process.stdin.flush()

    def read(self):
        for raw in self.process.stdout:
            line = raw.rstrip(b'\n')
            self.lines.append(('from', line))
            frame = json.loads(line)
            if 'method' in frame and 'id' in frame:
                threading.Thread(target=self.reply, args=(frame,), daemon=True).start()
            elif 'method' not in frame:
                waiter = self.pending.pop(frame.get('id'), None)
                if waiter is not None:
                    waiter.put(frame)
        for waiter in list(self.pending.values()):
            waiter.put(None)

    def reply(self, frame):
        try:
            result = self.serve(frame['method'], frame.get('params', {}))
            response = {'jsonrpc': '2.0', 'id': frame['id'], 'result': result}
        except Failure as failure:
            response = {'jsonrpc': '2.0', 'id': frame['id'],
                        'error': {'code': -32000, 'message': failure.message, 'data': {'code': failure.code}}}
        except Exception:
            self.errors.append(traceback.format_exc())
            response = {'jsonrpc': '2.0', 'id': frame['id'],
                        'error': {'code': -32000, 'message': 'Fixture host failed', 'data': {'code': 'host_failed'}}}
        self.write(response)

    def call(self, method, params, timeout=30):
        request = next(self.ids)
        waiter = queue.Queue()
        self.pending[request] = waiter
        self.write({'jsonrpc': '2.0', 'id': request, 'method': method, 'params': params})
        frame = waiter.get(timeout=timeout)
        if frame is None:
            raise Failure('host_unavailable', f'{self.name} disconnected')
        assert 'chunk' not in frame, f'{self.name} chunked a reply instead of using an artifact path'
        if 'error' in frame:
            data = frame['error'].get('data')
            code = data.get('code') if isinstance(data, dict) else None
            raise Failure(code or 'failed', frame['error'].get('message', 'failed'))
        return frame['result']

    def assert_frames_bounded(self, payload_bytes):
        assert self.lines, self.name
        longest = max(len(line) for _, line in self.lines)
        assert longest <= FRAME, f'{self.name} exchanged a {longest}-byte frame'
        assert not any(b'"chunk"' in line for _, line in self.lines), f'{self.name} used chunked frames'
        total = sum(len(line) for _, line in self.lines)
        # Every RPC line together is still smaller than the image it delivered,
        # so its bytes cannot have crossed the RPC channel in any encoding.
        assert total < payload_bytes, f'{self.name} moved {total} RPC bytes for a {payload_bytes}-byte image'
        assert not self.errors, self.errors

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=10)
        self.process.stdin.close()


class Endpoint(http.server.ThreadingHTTPServer):
    """Loopback OpenAI-compatible image endpoint that records exactly what it receives."""

    def __init__(self, observe):
        self.observe, self.requests, self.output = observe, [], None

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(handler):
                body = handler.rfile.read(int(handler.headers['Content-Length']))
                request = {'path': handler.path, 'headers': dict(handler.headers), 'body': body}
                request.update(multipart(handler.headers.get('Content-Type', ''), body))
                request['durable'] = self.observe()
                self.requests.append(request)
                reply = json.dumps({'data': [{'b64_json': base64.b64encode(self.output).decode()}],
                                    'model': 'actual-fixture-model'}).encode()
                handler.send_response(200)
                handler.send_header('Content-Type', 'application/json')
                handler.send_header('Content-Length', str(len(reply)))
                handler.send_header('x-request-id', 'fixture-request')
                handler.end_headers()
                handler.wfile.write(reply)

            def log_message(handler, *_):
                pass
        super().__init__(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def root(self):
        return f'http://127.0.0.1:{self.server_address[1]}/v1/images'


def multipart(content_type, body):
    """Exact bytes of each form part, in wire order (no newline normalization)."""
    if not content_type.startswith('multipart/form-data'):
        return {'fields': json.loads(body), 'images': []}
    boundary = content_type.split('boundary=', 1)[1].strip('"').encode()
    fields, images = {}, []
    for part in body.split(b'--' + boundary)[1:-1]:
        assert part.startswith(b'\r\n') and part.endswith(b'\r\n')
        headers, content = part[2:-2].split(b'\r\n\r\n', 1)
        disposition = next(line for line in headers.split(b'\r\n') if line.lower().startswith(b'content-disposition'))
        name = disposition.split(b'name="', 1)[1].split(b'"', 1)[0].decode()
        if b'filename="' in disposition:
            images.append((disposition.split(b'filename="', 1)[1].split(b'"', 1)[0].decode(), content))
        else:
            fields[name] = content
    return {'fields': fields, 'images': images}


class Broker:
    def __init__(self, root):
        self.root = root
        self.store = root / 'host-artifact-store'
        self.store.mkdir()
        self.artifacts, self.stages, self.acquired, self.processes = {}, {}, [], []
        self.operation = None
        self.after_capture = None
        self.before_start = None
        self.process_run = None
        home = root / 'isolated-home'
        home.mkdir()
        (root / 'codex-home').mkdir()
        (root / 'provider-tmp').mkdir()
        base = {key: value for key, value in os.environ.items() if key not in SECRET_VARIABLES}
        self.trace_env = dict(base, HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'))
        self.provider_env = dict(self.trace_env, CODEX_HOME=str(root / 'codex-home'), TMPDIR=str(root / 'provider-tmp'))
        self.trace_dir = root / 'trace-data'
        self.provider_dir = root / 'provider-data'
        self.trace_dir.mkdir()
        self.provider_dir.mkdir()
        self.provider = self.trace = None
        self.retired = []

    # Host contract shared by both plugins.
    def register(self, path, data, media='image/png'):
        handle = secrets.token_hex(16)
        descriptor = {'handle': handle, 'sha256': sha(data), 'byteLength': len(data), 'mediaType': media}
        self.artifacts[handle] = (path, descriptor)
        return descriptor

    def read(self, params):
        entry = self.artifacts.get(params['artifact'].get('handle'))
        if entry is None or entry[1] != params['artifact']:
            raise Failure('not_found', 'Unknown artifact grant')
        path, descriptor = entry
        if sha(path.read_bytes()) != descriptor['sha256']:
            raise Failure('corrupt', 'Stored artifact changed')
        return {'path': str(path), 'artifact': descriptor}

    def capture(self, params):
        captured = []
        for item in params['inputs']:
            data = Path(item['path']).read_bytes()
            if item.get('expectedDigest') not in (None, sha(data)):
                raise Failure('input_changed', 'Input changed before capture')
            width, height = dimensions(data)
            snapshot = self.store / f'input-{len(self.artifacts)}-{secrets.token_hex(4)}.png'
            snapshot.write_bytes(data)
            snapshot.chmod(0o400)
            captured.append({'sourcePath': item['path'], 'artifact': self.register(snapshot, data),
                             'width': width, 'height': height})
        if self.after_capture:
            self.after_capture()
        return {'inputs': captured}

    def serve_trace(self, method, params):
        if method == 'host.services.describe':
            assert params['packageId'] == PACKAGE
            return {'version': 1, 'available': True, 'providerDigest': 'b' * 64}
        if method == 'host.services.invoke':
            assert params['packageId'] == PACKAGE and params['major'] == 1
            if params['method'] == 'start' and self.before_start:
                self.before_start(params['params'])
            return self.provider.call(f"services.image-generation.v1.{params['method']}",
                                      {'caller': CALLER, 'request': params['params']})
        if method == 'host.artifacts.capture':
            return self.capture(params)
        if method == 'host.artifacts.read':
            return self.read(params)
        if method == 'host.artifacts.acquired':
            granted = self.read(params)
            assert Path(params['evidencePath']).read_bytes() == Path(granted['path']).read_bytes()
            receipt = secrets.token_hex(24)
            self.acquired.append(receipt)
            return {'transferReceipt': receipt}
        if method == 'host.artifacts.release':
            return {'released': True}
        raise Failure('method_not_found', f'Unexpected Trace host call {method}')

    def serve_provider(self, method, params):
        if method == 'host.artifacts.read':
            return self.read(params)
        if method == 'host.artifacts.stage':
            handle = secrets.token_hex(16)
            path = self.store / f'stage-{handle}.png'
            path.write_bytes(b'')
            self.stages[handle] = path
            return {'handle': handle, 'path': str(path)}
        if method == 'host.artifacts.seal':
            path = self.stages.pop(params['handle'])
            data = path.read_bytes()
            path.chmod(0o400)
            descriptor = {'handle': params['handle'], 'sha256': sha(data), 'byteLength': len(data),
                          'mediaType': params['mediaType']}
            self.artifacts[params['handle']] = (path, descriptor)
            return descriptor
        if method == 'host.process.run':
            if params['args'] == ['login', 'status']:
                stdout, stderr = self.root / 'login.stdout', self.root / 'login.stderr'
                stdout.write_text('Logged in using ChatGPT\n')
                stderr.write_text('')
                return {'handle': 'fixture-login', 'status': 0, 'stdout': str(stdout), 'stderr': str(stderr)}
            return self.process_run(params)
        if method == 'host.process.release':
            return None
        raise Failure('method_not_found', f'Unexpected provider host call {method}')

    def start_provider(self):
        self.provider = Peer('provider', [str(PROVIDER), '--data-dir', str(self.provider_dir)],
                             self.serve_provider, self.provider_env)
        self.provider.call('initialize', {'protocolVersion': 1, 'processService': True, 'serviceService': {'version': 1},
                                          'artifactService': {'version': 1}, 'credentialService': {'version': 1},
                                          'jobService': {'version': 1}, 'hostControl': {'token': 'a' * 64}})
        assert self.provider.call('lifecycle.activate', {})['ready'] is True

    def restart_provider(self):
        self.provider.close()
        self.retired.append(self.provider)
        self.start_provider()

    def save_profile(self, profile):
        revision = self.document_revision
        saved = self.provider.call('settings.save', {'expectedRevision': revision, 'configuration': {
            'schemaVersion': 1, 'documentRevision': revision, 'defaultConnectionId': profile['id'], 'profiles': [profile]}})
        self.document_revision = saved['documentRevision']
        return saved['profiles'][0]['recipeRevision']

    def start_trace(self):
        self.trace = Peer('trace', [str(TRACE), '--data-dir', str(self.trace_dir)], self.serve_trace, self.trace_env)
        ready = self.trace.call('initialize', {'protocolVersion': 1, 'activeRunIds': [], 'deferRecovery': True,
                                               'serviceService': {'version': 1}, 'artifactService': {'version': 1}})
        assert ready['ready'] is False
        assert self.trace.call('lifecycle.activate', {})['ready'] is True

    def durable(self):
        """Trace's committed state for the current operation, read by another process."""
        with sqlite3.connect(f'file:{self.trace_dir / "trace.sqlite"}?mode=ro', uri=True) as connection:
            row = connection.execute('SELECT r.parameters,r.status,o.body FROM image_service_operations o JOIN runs r '
                                     'ON r.id=o.run_id WHERE o.operation_id=?', (self.operation,)).fetchone()
        assert row is not None, 'Provider was invoked before Trace committed its run'
        return {'parameters': json.loads(row[0]), 'status': row[1], 'link': json.loads(row[2])}

    def submit(self, request, operation, job=9):
        self.operation = operation
        assert self.trace.call('jobs.start', {'kind': 'openai-image', 'jobId': job, 'operationId': operation,
                                              'request': request}) == job

    def settle(self, states):
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            value = self.trace.call('jobs.status', {'operationId': self.operation})
            if value and value.get('recoveryState') in states and not value.get('workerActive'):
                return value
            time.sleep(.05)
        raise AssertionError(f'Trace did not settle to {states}: {value}')

    def close(self):
        for peer in (self.trace, self.provider, *self.retired):
            if peer is not None:
                peer.close()


def http_profile(endpoint):
    return {'id': 'http', 'name': 'Loopback fixture', 'recipeRevision': '', 'transport': 'openai-images',
            'baseUrl': endpoint, 'defaultModel': 'fixture-default-model', 'allowInsecureHttp': False,
            'credential': {'kind': 'none'}}


def photos(root, names_and_sizes):
    folder = root / 'photos'
    folder.mkdir(exist_ok=True)
    originals = []
    for name, (width, height) in names_and_sizes:
        data = png(width, height)
        (folder / name).write_bytes(data)
        originals.append((folder / name, data))
    return folder, originals


def mutate(originals):
    def rewrite():
        for path, data in originals:
            path.write_bytes(png(*dimensions(data)))
    return rewrite


def edit_request(folder, originals, connection, revision, model, prompt):
    (first, first_bytes), *rest = originals
    return {'connectionId': connection, 'expectedConnectionRevision': revision, 'model': model,
            'sourcePath': str(first), 'expectedSourceDigest': sha(first_bytes),
            'referencePaths': [str(path) for path, _ in rest],
            'expectedReferenceDigests': [sha(data) for _, data in rest],
            'prompt': prompt, 'outputDir': str(folder), 'outputFilename': 'result.png',
            'size': '1024x1024', 'quality': 'auto', 'background': 'auto'}


PROMPT = 'Blend these: keep the "zeta" sky,\nthe alpha\\mid colours and 🙂 glyphs\ttogether'


def scenario_ordered_large_http(broker):
    endpoint = Endpoint(broker.durable)
    try:
        broker.start_provider()
        revision = broker.save_profile(http_profile(endpoint.root))
        # Selection order is deliberately not alphabetical, by name or by size.
        folder, originals = photos(broker.root, [('zeta-first.png', (24, 16)), ('alpha-second.png', (16, 24)),
                                                 ('mid-third.png', (20, 20))])
        broker.after_capture = mutate(originals)
        endpoint.output = png(1200, 1200)
        assert len(endpoint.output) > 4 * FRAME
        broker.start_trace()
        broker.submit(edit_request(folder, originals, 'http', revision, 'fixture-image-model', PROMPT), 'ab' * 16)
        value = broker.settle({'succeeded'})
        assert len(endpoint.requests) == 1
        wire = endpoint.requests[0]
        assert wire['path'] == '/v1/images/edits'
        # Ordered immutable inputs: the endpoint received the captured snapshots,
        # in selection order, although every original changed after capture.
        assert [name for name, _ in wire['images']] == ['source-1.png', 'source-2.png', 'source-3.png']
        assert [content for _, content in wire['images']] == [data for _, data in originals]
        assert all(path.read_bytes() != data for path, data in originals)
        # The effective request was durable in Trace before the provider sent it,
        # and is byte-identical to what the endpoint observed.
        durable = wire['durable']
        parameters, recipe = durable['parameters'], durable['link']['recipe']
        assert durable['status'] == 'running' and durable['link']['phase'] in ('forwarding', 'running')
        assert parameters['submitted_prompt'].encode() == wire['fields']['prompt']
        assert recipe['submittedPrompt'] == parameters['submitted_prompt'] and recipe['agentTask'] is None
        assert parameters['effective_recipe'] == recipe
        assert parameters['prompt'] == PROMPT
        # Multi-image framing wraps the user's words as JSON after the equal-input roles.
        assert wire['fields']['prompt'].endswith(json.dumps({'prompt': PROMPT}, ensure_ascii=False, separators=(',', ':')).encode())
        assert len(parameters['input_roles']) == 3
        assert recipe['inputDigests'] == [sha(data) for _, data in originals]
        assert wire['fields']['model'] == recipe['model'].encode() == b'fixture-image-model'
        for field in ('size', 'quality', 'background'):
            assert wire['fields'][field] == recipe['options'][field].encode()
        # The >4 MiB output reached Trace by artifact path, exactly.
        output = Path(value['outputPath'])
        assert output.read_bytes() == endpoint.output
        with sqlite3.connect(broker.trace_dir / 'trace.sqlite') as connection:
            digest = connection.execute('SELECT digest FROM artifacts WHERE generating_run=?', (value['runId'],)).fetchone()[0]
        assert digest == sha(endpoint.output) == sha(output.read_bytes())
        assert len(broker.acquired) == 1
        broker.trace.assert_frames_bounded(len(endpoint.output))
        broker.provider.assert_frames_bounded(len(endpoint.output))
        longest = max(len(line) for _, line in broker.trace.lines + broker.provider.lines)
        # The bound is still enforced: a well-formed request one byte over it
        # closes Trace's input instead of being answered.
        pad = FRAME - len(b'{"jsonrpc":"2.0","id":4242,"method":"jobs.status","params":{"operationId":"","pad":""}}') + 1
        broker.trace.write_raw(json.dumps({'jsonrpc': '2.0', 'id': 4242, 'method': 'jobs.status',
                                           'params': {'operationId': '', 'pad': 'x' * pad}}, separators=(',', ':')).encode())
        assert broker.trace.process.wait(timeout=10) is not None
        assert not any(b'"id":4242' in line for direction, line in broker.trace.lines if direction == 'from')
        print('PASS ordered-large-http: 3 immutable ordered inputs, durable recipe == wire prompt, '
              f'{len(endpoint.output)}-byte output by artifact path, max frame {longest} bytes')
    finally:
        endpoint.shutdown()


def rejected_before_dispatch(broker, endpoint, change, code):
    broker.start_provider()
    revision = broker.save_profile(http_profile(endpoint.root))
    folder, originals = photos(broker.root, [('second.png', (8, 8)), ('first.png', (9, 9))])
    broker.before_start = change
    broker.start_trace()
    broker.submit(edit_request(folder, originals, 'http', revision, 'fixture-image-model', PROMPT), 'cd' * 16)
    value = broker.settle({'failed'})
    assert endpoint.requests == [], 'A rejected preparation reached the image endpoint'
    assert value['status'] == 'failed' and value['providerExecution']['state'] == 'failed'
    status = broker.provider.call('services.image-generation.v1.status', {'caller': CALLER, 'request': {'operationId': broker.operation}})
    assert status['execution']['state'] == 'failed' and status['execution']['error']['code'] == code, status
    assert broker.durable()['parameters']['effective_recipe']['connectionRevision'] == revision
    return value


def scenario_profile_change(broker):
    endpoint = Endpoint(broker.durable)
    try:
        def change(_):
            broker.save_profile(http_profile(endpoint.root.replace('/v1/images', '/moved/v1/images')))
        value = rejected_before_dispatch(broker, endpoint, change, 'configuration_changed')
        print(f"PASS profile-change: start refused with {value['error']!r}; 0 endpoint requests")
    finally:
        endpoint.shutdown()


def scenario_provider_restart(broker):
    endpoint = Endpoint(broker.durable)
    try:
        # A provider upgrade (new formatter) restarts the process: preparations
        # made by the old process cannot be started by the new one.
        value = rejected_before_dispatch(broker, endpoint, lambda _: broker.restart_provider(), 'preparation_expired')
        print(f"PASS provider-restart: start refused with {value['error']!r}; 0 endpoint requests")
    finally:
        endpoint.shutdown()


def scenario_cli_task(broker):
    program = broker.root / 'fixture-codex'
    program.write_text('#!/bin/sh\nexit 97\n')
    program.chmod(0o700)

    def run(params):
        images = [Path(params['args'][index + 1]).read_bytes()
                  for index, arg in enumerate(params['args']) if arg == '--image']
        broker.processes.append({'args': params['args'], 'images': images, 'durable': broker.durable()})
        raise Failure('interrupted', 'Owned plugin process did not provide a complete result')
    broker.process_run = run
    broker.start_provider()
    revision = broker.save_profile({'id': 'cli', 'name': 'Fixture CLI', 'recipeRevision': '', 'transport': 'codex-cli',
                                    'executablePath': str(program), 'modelSelection': False,
                                    'credential': {'kind': 'cli_saved_login'}})
    folder, originals = photos(broker.root, [('yellow.png', (12, 10)), ('blue.png', (10, 12))])
    broker.after_capture = mutate(originals)
    broker.start_trace()
    broker.submit(edit_request(folder, originals, 'cli', revision, None, PROMPT), 'ef' * 16)
    value = broker.settle({'needs_attention'})
    assert len(broker.processes) == 1
    invocation = broker.processes[0]
    parameters, recipe = invocation['durable']['parameters'], invocation['durable']['link']['recipe']
    assert invocation['args'][-2] == '--' and invocation['args'][-1] == parameters['agent_task'] == recipe['agentTask']
    assert parameters['submitted_prompt'] == recipe['submittedPrompt'] and recipe['adapter'] == 'codex-cli'
    assert '--model' not in invocation['args']
    assert invocation['images'] == [data for _, data in originals]
    assert value['status'] == 'uncertain' and value['providerExecution']['state'] == 'unknown'
    print('PASS cli-task: durable agent task == executed task; ordered captured images; unknown outcome not retried')


RUN = {'ordered-large-http': scenario_ordered_large_http, 'profile-change': scenario_profile_change,
       'provider-restart': scenario_provider_restart, 'cli-task': scenario_cli_task}
for name in SCENARIOS:
    directory = tempfile.mkdtemp(prefix=f'te-shared-ai-{name}-')
    broker = Broker(Path(directory).resolve())
    broker.document_revision = 0
    try:
        RUN[name](broker)
    except BaseException:
        for peer in (broker.trace, broker.provider):
            if peer is not None:
                sys.stderr.write(f'--- {peer.name} stderr\n' + b''.join(peer.stderr).decode(errors='replace')[-4000:])
                sys.stderr.write(''.join(peer.errors))
        raise
    finally:
        broker.close()
        shutil.rmtree(directory, ignore_errors=True)
