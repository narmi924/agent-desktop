'use strict';

const { createHash } = require('node:crypto');
const { userInfo } = require('node:os');
const { join } = require('node:path');
const { stateDir } = require('./routine-store');

function hostDir() {
  return join(stateDir(), 'host');
}

/** One pipe per Windows user and state folder, so two users or two state folders never meet. */
function pipePath() {
  if (process.env.AGENT_DESKTOP_HOST_PIPE) return process.env.AGENT_DESKTOP_HOST_PIPE;
  const key = createHash('sha256').update(userInfo().username + '\0' + stateDir()).digest('hex').slice(0, 16);
  return process.platform === 'win32' ? '\\\\.\\pipe\\agent-desktop-host-' + key : join(hostDir(), 'host-' + key + '.sock');
}

const tokenPath = () => join(hostDir(), 'token');
const jobsDir = () => join(hostDir(), 'jobs');

module.exports = { hostDir, pipePath, tokenPath, jobsDir };
