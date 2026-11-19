import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ComputerMcpConfig } from '@neometaharness/kernel';
export class FakeMcpEngine {
  private child;
  private seq = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; method: string }>();
  private exited: Promise<void>;
  stderr = '';
  constructor(config: ComputerMcpConfig) {
    this.child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = JSON.parse(line); const pending = this.pending.get(message.id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.reject(Error(pending.method + ' ' + JSON.stringify(message.error) + ' ' + this.stderr)) : pending.resolve(message.result); }
    });
    this.exited = new Promise((done) => this.child.once('exit', () => {
      for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(Error('MCP server exited')); }
      this.pending.clear(); done();
    }));
  }
  async request(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.seq;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`MCP ${method} timed out`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return result;
  }
  async initialize() {
    const result = await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-engine', version: '1' } });
    assert.ok(result.capabilities.tools);
    this.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    return this.request('tools/list');
  }
  call(name: string, args = {}) { return this.request('tools/call', { name, arguments: args }); }
  async close() { this.child.stdin.end(); const timer = setTimeout(() => this.child.kill(), 2000); try { await this.exited; } finally { clearTimeout(timer); } }
}
