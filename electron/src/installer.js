'use strict';

const { hasCompatibleRay, ensureRayRuntime, PINNED_RAY_VERSION } = require('./bootstrap');
const { appendAudit, makeAuditEvent } = require('./storage');

class RayInstaller {
  constructor() {
    this._status = {
      running: false,
      succeeded: null,
      message: 'Not started',
      command: [`ray[default]==${PINNED_RAY_VERSION}`],
      started_at: null,
      finished_at: null,
      log_tail: [],
    };
    this._running = false;
  }

  status() {
    return { ...this._status, log_tail: [...this._status.log_tail] };
  }

  start() {
    if (this._running) return this.status();

    if (hasCompatibleRay()) {
      this._status = {
        ...this._status,
        running: false,
        succeeded: true,
        message: `Pinned Ray runtime is already installed: ${PINNED_RAY_VERSION}`,
        finished_at: new Date().toISOString(),
      };
      return this.status();
    }

    this._running = true;
    this._status = {
      ...this._status,
      running: true,
      succeeded: null,
      message: 'Installing Ray...',
      started_at: new Date().toISOString(),
      finished_at: null,
      log_tail: [],
    };

    // Run async without blocking — callers poll status().
    this._run().catch(() => {});
    return this.status();
  }

  async _run() {
    try {
      const logTail = [];
      const onOutput = (line) => {
        logTail.push(line);
        if (logTail.length > 30) logTail.shift();
        this._status.log_tail = [...logTail];
        this._status.message = line.slice(0, 240);
      };

      const result = await ensureRayRuntime(onOutput);
      this._status.succeeded = result.succeeded;
      this._status.message = result.message;
      await appendAudit(makeAuditEvent('ray_install_finished', result.message, { succeeded: result.succeeded }));
    } catch (err) {
      this._status.succeeded = false;
      this._status.message = `Ray installation failed: ${err.message}`;
      await appendAudit(makeAuditEvent('ray_install_finished', this._status.message, { succeeded: false }));
    } finally {
      this._status.running = false;
      this._status.finished_at = new Date().toISOString();
      this._running = false;
    }
  }
}

module.exports = { RayInstaller };
