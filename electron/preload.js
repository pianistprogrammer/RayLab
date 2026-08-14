'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  invoke(channel, args) {
    const allowed = [
      'open_dashboard', 'backend_status',
      'health', 'get_config', 'save_config',
      'cluster_status', 'diagnostics', 'run_network_preflight', 'hardware', 'terminal_logs',
      'discovery_coordinators',
      'ray_install_status', 'install_ray',
      'setup_status', 'run_setup', 'create_worker_account', 'install_docker',
      'cluster_start', 'cluster_port_conflicts', 'cluster_clear_port_conflicts', 'cluster_stop', 'cluster_panic',
      'nodes', 'audit',
      'create_submitter', 'revoke_submitter',
      'submit_job', 'kill_job',
    ];
    if (!allowed.includes(channel)) {
      return Promise.reject(new Error(`Unknown IPC channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, args);
  },
});
