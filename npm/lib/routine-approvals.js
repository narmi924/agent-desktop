'use strict';

const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { routinesDir, stateDir } = require('./routine-store');

const approvalsPath = () => join(routinesDir(), 'approvals.json');
const protectedPath = () => join(stateDir(), 'protected.json');

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/** What a standing approval is tied to: the routine's script, so changing the routine voids it. */
function scriptHash(script) {
  return createHash('sha256').update(String(script)).digest('hex');
}

/** Standing approvals, written only after a person clicked "以后都允许这个动作" in the confirmation window. */
function approvals() {
  return readJson(approvalsPath(), {});
}

function approved(name, script) {
  const entry = approvals()[name];
  return Boolean(entry && entry.hash === scriptHash(script));
}

function approve(name, script) {
  mkdirSync(routinesDir(), { recursive: true });
  const all = approvals();
  all[name] = { hash: scriptHash(script), at: new Date().toISOString() };
  const temporary = approvalsPath() + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(all, null, 1));
  renameSync(temporary, approvalsPath());
}

function revoke(name) {
  const all = approvals();
  const had = Object.hasOwn(all, name);
  delete all[name];
  mkdirSync(routinesDir(), { recursive: true });
  writeFileSync(approvalsPath(), JSON.stringify(all, null, 1));
  return had;
}

/**
 * Apps and sites the user listed in protected.json under the state folder: {"apps": ["xxx.exe"], "hosts": ["bank.example"]}.
 * Only a routine with a standing approval may act on them. The list is the user's data; no name is built in.
 */
function protectedSurfaces() {
  const raw = readJson(protectedPath(), {});
  const lower = list => (Array.isArray(list) ? list : []).map(item => String(item).toLowerCase());
  return { apps: lower(raw.apps), hosts: lower(raw.hosts) };
}

function surfaceRefused(touched) {
  const { apps, hosts } = protectedSurfaces();
  const app = touched.app && apps.includes(String(touched.app).toLowerCase()) ? touched.app : undefined;
  const host = touched.host && hosts.some(h => String(touched.host).toLowerCase() === h || String(touched.host).toLowerCase().endsWith('.' + h)) ? touched.host : undefined;
  if (!app && !host) return undefined;
  return Object.assign(new Error((app ? 'The app ' + app : 'The site ' + host) + ' is protected: only a saved routine the user approved may act on it. ' +
    'Nothing was sent.'), { code: 'SURFACE_PROTECTED', details: { app, host } });
}

module.exports = { scriptHash, approvals, approved, approve, revoke, protectedSurfaces, surfaceRefused, approvalsPath, protectedPath };
