'use strict';
// A paid case is recorded BEFORE dispatch and checkpointed after completion.
// A dispatch without an outcome is ambiguous and must never be sent again.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { digest } = require('./benchmark');

function atomicWrite(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function acquireLock(file) {
  const token = crypto.randomUUID();
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('Invalid benchmark lock; inspect it before recovery');
    let dead = false;
    try { process.kill(previous.pid, 0); } catch (check) { dead = check.code === 'ESRCH'; }
    if (!dead) throw new Error('Benchmark journal is locked by a running or inaccessible process');
    fs.unlinkSync(file);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
  }
  return () => {
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
  };
}

function openJournal(file, { identity, metadata, caseIds, resume = false }) {
  file = path.resolve(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = acquireLock(file + '.lock');
  let state;
  const save = () => atomicWrite(file, state);
  try {
    if (resume) {
      if (!fs.existsSync(file)) throw new Error('No journal to resume; do not recreate an interrupted unjournaled run');
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.schema_version !== 1 || digest(state.identity) !== digest(identity)) throw new Error('Benchmark configuration/source changed; cannot mix results in one run');
      if (!Array.isArray(state.cases) || state.cases.length !== caseIds.length || state.cases.some((item, index) => item.case_id !== caseIds[index] || !['pending', 'dispatched', 'finished'].includes(item.state) || item.state === 'finished' && item.outcome?.case_id !== item.case_id)) throw new Error('Invalid benchmark journal case list');
      for (const item of state.cases) if (item.state === 'dispatched') {
        item.state = 'finished';
        item.finished_at = new Date().toISOString();
        const settings = identity.metadata?.settings;
        const maxRequests = settings ? settings.samples * (1 + settings.repair_attempts) * settings.llm_max_attempts : 1;
        item.outcome = { case_id: item.case_id, error: { code: 'INTERRUPTED_UNKNOWN_USAGE' }, usage: null, cost_usd: null, billing_complete: false, unknown_call_count: maxRequests, unknown_call_count_is_upper_bound: true };
      }
      save();
    } else {
      if (fs.existsSync(file)) throw new Error('Benchmark journal already exists; use --resume to avoid duplicate paid work');
      state = { schema_version: 1, identity, metadata, cases: caseIds.map(case_id => ({ case_id, state: 'pending' })) };
      save();
    }
  } catch (error) { release(); throw error; }
  return {
    metadata: state.metadata,
    pending: () => state.cases.filter(item => item.state === 'pending').map(item => item.case_id),
    dispatch(caseId) {
      const item = state.cases.find(entry => entry.case_id === caseId);
      if (!item || item.state !== 'pending') throw new Error('Refusing duplicate benchmark dispatch');
      item.state = 'dispatched'; item.dispatched_at = new Date().toISOString(); save();
    },
    finish(outcome) {
      const item = state.cases.find(entry => entry.case_id === outcome.case_id);
      if (!item || item.state !== 'dispatched') throw new Error('Benchmark completion without dispatch');
      item.state = 'finished'; item.outcome = outcome; item.finished_at = new Date().toISOString(); save();
    },
    outcomes: () => state.cases.filter(item => item.state === 'finished').map(item => item.outcome),
    close: release,
  };
}

module.exports = { openJournal, atomicWrite };
