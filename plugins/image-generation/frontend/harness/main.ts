import { mount } from 'svelte';
import Harness from './Harness.svelte';
import './tokens.css';
mount(Harness, { target: document.getElementById('app')! });
