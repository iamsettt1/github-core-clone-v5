// Git object layer: SHA-1 addressed objects, trees, packs, pkt-lines,
// smart-HTTP fetch / receive logic, branch file maps and the three-way
// merge used by pull requests. Objects are immutable, so pack entries
// are deflated once and cached by oid forever.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  objects, packEntryCache, bumpRepo, VIEWER_NAME, VIEWER_EMAIL, ZERO_OID,
  type GitObj, type ObjType, type Repo, type FileEnt,
} from './core.ts';

const TYPE_NUM: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEXC = '0123456789abcdef';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function oidOf(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Generation of a commit: 1 + max parent generation, 0 for a root. */
export function commitGen(oid: string): number {
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'commit') return 0;
  if (obj.gen >= 0) return obj.gen;
  let g = 0;
  for (const p of obj.parents) {
    const pg = commitGen(p) + 1;
    if (pg > g) g = pg;
  }
  obj.gen = g;
  return g;
}

export function storeObject(type: ObjType, data: Buffer): string {
  const oid = oidOf(type, data);
  if (objects.has(oid)) return oid;
  const obj: GitObj = { type, data, gen: -1, parents: [], tree: '' };
  if (type === 'commit') {
    // Header lines run to the first blank line: tree, then parents.
    let pos = 0;
    while (pos < data.length) {
      const nl = data.indexOf(10, pos);
      if (nl === -1 || nl === pos) break;
      const line = data.toString('utf8', pos, nl);
      if (line.startsWith('tree ')) obj.tree = line.slice(5, 45);
      else if (line.startsWith('parent ')) obj.parents.push(line.slice(7, 47));
      else if (!line.startsWith('author ') && !line.startsWith('committer ') && !line.startsWith('gpgsig')) break;
      pos = nl + 1;
    }
    let g = 0;
    let known = true;
    for (const p of obj.parents) {
      const po = objects.get(p);
      if (!po || po.gen < 0) { known = false; break; }
      if (po.gen + 1 > g) g = po.gen + 1;
    }
    obj.gen = obj.parents.length === 0 ? 0 : (known ? g : -1);
  }
  objects.set(oid, obj);
  return oid;
}

export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; author: string; committer: string } {
  const text = data.toString('utf8');
  const splitAt = text.indexOf('\n\n');
  const head = splitAt === -1 ? text : text.slice(0, splitAt);
  const message = splitAt === -1 ? '' : text.slice(splitAt + 2).replace(/\n$/, '');
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

export function parseIdent(line: string): { name: string; email: string; date: string } {
  const lt = line.indexOf('<');
  const gt = line.indexOf('>', lt);
  const name = lt === -1 ? line.trim() : line.slice(0, lt).trim();
  const email = lt === -1 || gt === -1 ? '' : line.slice(lt + 1, gt);
  const rest = gt === -1 ? '' : line.slice(gt + 1).trim();
  const ts = Number(rest.split(' ')[0]);
  const date = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : new Date(0).toISOString();
  return { name, email, date };
}

interface TreeEntry { mode: string; name: string; oid: string }

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(32, pos);
    const mode = data.toString('utf8', pos, sp);
    const nul = data.indexOf(0, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    out.push({ mode, name, oid });
    pos = nul + 21;
  }
  return out;
}

/** Build (and store) tree objects bottom-up from a flat path -> blob map. */
export function buildTree(files: Map<string, string>): string {
  type Node = Map<string, string | Node>;
  const root: Node = new Map();
  for (const [path, blob] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.get(parts[i]) as Node | undefined;
      if (!next || typeof next === 'string') { next = new Map(); node.set(parts[i], next); }
      node = next;
    }
    node.set(parts[parts.length - 1], blob);
  }
  const emit = (node: Node): string => {
    const entries: { key: string; mode: string; name: string; oid: string }[] = [];
    for (const [name, val] of node) {
      if (typeof val === 'string') entries.push({ key: name, mode: '100644', name, oid: val });
      else { const oid = emit(val); entries.push({ key: `${name}/`, mode: '40000', name, oid }); }
    }
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const chunks: Buffer[] = [];
    let total = 0;
    for (const e of entries) {
      const head = Buffer.from(`${e.mode} ${e.name}\0`, 'utf8');
      const raw = Buffer.from(e.oid, 'hex');
      chunks.push(head, raw);
      total += head.length + raw.length;
    }
    const data = Buffer.concat(chunks, total);
    return storeObject('tree', data);
  };
  return emit(root);
}

function flattenInto(treeOid: string, prefix: string, out: Map<string, FileEnt>): void {
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenInto(e.oid, path, out);
    else {
      const blob = objects.get(e.oid);
      out.set(path, { blob: e.oid, size: blob ? blob.data.length : 0 });
    }
  }
}

/** Flat file map for a ref, cached until the repo version moves. */
export function branchFiles(repo: Repo, ref: string): Map<string, FileEnt> {
  const hit = repo.fileCache.get(ref);
  if (hit) return hit;
  const out = new Map<string, FileEnt>();
  const tip = repo.refs.get(ref);
  if (tip) {
    const commit = objects.get(tip);
    if (commit && commit.type === 'commit' && commit.tree) flattenInto(commit.tree, '', out);
  }
  repo.fileCache.set(ref, out);
  return out;
}

/** Tree-object oid for a directory path inside a tree ('' = the root). */
export function dirTreeOid(treeOid: string, parts: string[]): string | null {
  let cur = treeOid;
  for (const part of parts) {
    const obj = objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    cur = entry.oid;
  }
  return cur;
}

export function makeCommit(files: Map<string, string>, parent: string | null, message: string): string {
  const tree = buildTree(files);
  const ts = Math.floor(Date.now() / 1000);
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  let head = `tree ${tree}\n`;
  if (parent) head += `parent ${parent}\n`;
  head += `author ${ident}\ncommitter ${ident}\n\n`;
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return storeObject('commit', Buffer.from(head + body, 'utf8'));
}

// ---------- packs ----------

function packEntry(oid: string): Buffer | null {
  const cached = packEntryCache.get(oid);
  if (cached) return cached;
  const obj = objects.get(oid);
  if (!obj) return null;
  const typeNum = TYPE_NUM[obj.type];
  let size = obj.data.length;
  const headBytes: number[] = [];
  let first = (typeNum << 4) | (size & 15);
  size >>= 4;
  if (size > 0) first |= 0x80;
  headBytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    headBytes.push(b);
  }
  const deflated = deflateSync(obj.data, { level: 1 });
  const entry = Buffer.concat([Buffer.from(headBytes), deflated]);
  packEntryCache.set(oid, entry);
  return entry;
}

export function buildPack(oids: string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of oids) {
    const entry = packEntry(oid);
    if (entry) parts.push(entry);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Compressed lengths repeat across a workload (same client, same object
 * shapes), so keep the last seen length per (type, size) as a prediction:
 * the exact-length search then runs inside a narrow window instead of
 * the whole buffer. Wrong predictions fall back to the wide search.
 */
const predictedLen = new Map<string, number>();

function tryInflate(buf: Buffer, pos: number, len: number, expectedSize: number): Buffer | null {
  try {
    const data = inflateSync(buf.subarray(pos, pos + len));
    return data.length === expectedSize ? data : null;
  } catch {
    return null;
  }
}

/** Smallest length in (lo, hi] that inflates to expectedSize; hi must work. */
function searchWindow(buf: Buffer, pos: number, lo: number, hi: number, expectedSize: number): { data: Buffer; used: number } {
  let data = tryInflate(buf, pos, hi, expectedSize);
  if (!data) throw new Error('inflate failed');
  let low = lo + 1;
  let high = hi;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (tryInflate(buf, pos, mid, expectedSize)) high = mid;
    else low = mid + 1;
  }
  if (low !== hi) data = tryInflate(buf, pos, low, expectedSize) ?? data;
  return { data, used: low };
}

/** Inflate one deflate stream starting at pos; returns data + bytes used. */
function inflateAt(buf: Buffer, pos: number, expectedSize: number, typeNum: number, exactEnd: number): { data: Buffer; used: number } {
  const remaining = buf.length - pos;
  // The pack's final entry ends exactly at the trailer: one probe, done.
  if (exactEnd > pos && exactEnd - pos <= remaining) {
    const data = tryInflate(buf, pos, exactEnd - pos, expectedSize);
    if (data) return { data, used: exactEnd - pos };
  }
  const key = `${typeNum}:${expectedSize}`;
  const predicted = predictedLen.get(key);
  if (predicted !== undefined && predicted <= remaining) {
    let hi = Math.min(remaining, predicted + 4);
    if (tryInflate(buf, pos, hi, expectedSize)) {
      // Walk the lower bound down until a probe fails, then binary-search
      // the (usually narrow) window between the last failure and hi.
      let lo = Math.max(0, predicted - 44);
      while (lo > 0 && tryInflate(buf, pos, lo, expectedSize)) {
        hi = lo;
        lo = Math.max(0, lo - 44);
      }
      const found = searchWindow(buf, pos, lo, hi, expectedSize);
      predictedLen.set(key, found.used);
      return found;
    }
  }
  let len = Math.min(remaining, Math.max(48, expectedSize + 32));
  let prevFail = 0;
  for (;;) {
    const data = tryInflate(buf, pos, len, expectedSize);
    if (data) {
      const found = searchWindow(buf, pos, prevFail, len, expectedSize);
      predictedLen.set(key, found.used);
      return found;
    }
    if (len >= remaining) throw new Error('inflate failed');
    prevFail = len;
    len = Math.min(remaining, len * 2);
  }
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // source size
  const targetSize = readVarint();
  const out = Buffer.alloc(targetSize);
  let outPos = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 0x01) off = delta[pos++];
      if (op & 0x02) off |= delta[pos++] << 8;
      if (op & 0x04) off |= delta[pos++] << 16;
      if (op & 0x08) off |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, outPos, off, off + size);
      outPos += size;
    } else if (op > 0) {
      delta.copy(out, outPos, pos, pos + op);
      pos += op;
      outPos += op;
    } else {
      throw new Error('bad delta opcode');
    }
  }
  return out;
}

/** Parse a pack starting at offset, storing every object. Returns count. */
export function parsePack(buf: Buffer, start: number): number {
  if (buf.length - start < 12 || buf.toString('ascii', start, start + 4) !== 'PACK') {
    throw new Error('not a pack');
  }
  const count = buf.readUInt32BE(start + 8);
  let pos = start + 12;
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  for (let i = 0; i < count; i++) {
    const entryStart = pos;
    let b = buf[pos++];
    const typeNum = (b >> 4) & 7;
    let size = b & 15;
    let shift = 4;
    while (b & 0x80) {
      b = buf[pos++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const exactEnd = i === count - 1 ? buf.length - 20 : 0;
    if (typeNum === 6) {
      // OFS_DELTA
      let byte = buf[pos++];
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[pos++];
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      const base = byOffset.get(entryStart - offset);
      if (!base) throw new Error('ofs-delta base missing');
      const { data: deltaData, used } = inflateAt(buf, pos, size, typeNum, exactEnd);
      pos += used;
      const data = applyDelta(base.data, deltaData);
      const oid = storeObject(base.type, data);
      byOffset.set(entryStart, { type: base.type, data });
      void oid;
    } else if (typeNum === 7) {
      // REF_DELTA
      const baseOid = buf.toString('hex', pos, pos + 20);
      pos += 20;
      const base = objects.get(baseOid);
      if (!base) throw new Error('ref-delta base missing');
      const { data: deltaData, used } = inflateAt(buf, pos, size, typeNum, exactEnd);
      pos += used;
      const data = applyDelta(base.data, deltaData);
      storeObject(base.type, data);
      byOffset.set(entryStart, { type: base.type, data });
    } else {
      const type = NUM_TYPE[typeNum];
      if (!type) throw new Error('bad pack type');
      const { data, used } = inflateAt(buf, pos, size, typeNum, exactEnd);
      pos += used;
      storeObject(type, data);
      byOffset.set(entryStart, { type, data });
    }
  }
  return count;
}

// ---------- pkt-lines ----------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const out = Buffer.allocUnsafe(len);
  out[0] = HEXC.charCodeAt((len >> 12) & 15);
  out[1] = HEXC.charCodeAt((len >> 8) & 15);
  out[2] = HEXC.charCodeAt((len >> 4) & 15);
  out[3] = HEXC.charCodeAt(len & 15);
  data.copy(out, 4);
  return out;
}

/** A pkt-line whose payload is band byte 1 followed by `data` (sideband). */
export function pktLineBand1(data: Buffer): Buffer {
  const len = data.length + 5;
  const out = Buffer.allocUnsafe(len);
  out[0] = HEXC.charCodeAt((len >> 12) & 15);
  out[1] = HEXC.charCodeAt((len >> 8) & 15);
  out[2] = HEXC.charCodeAt((len >> 4) & 15);
  out[3] = HEXC.charCodeAt(len & 15);
  out[4] = 1;
  data.copy(out, 5);
  return out;
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
  next: number;
}

export function readPkt(buf: Buffer, pos: number): Pkt {
  if (pos + 4 > buf.length) throw new Error('short pkt-line');
  const hex = buf.toString('ascii', pos, pos + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
  const len = parseInt(hex, 16);
  if (len === 0) return { kind: 'flush', payload: Buffer.alloc(0), next: pos + 4 };
  if (len === 1) return { kind: 'delim', payload: Buffer.alloc(0), next: pos + 4 };
  if (len < 4 || pos + len > buf.length) throw new Error('bad pkt-line length');
  return { kind: 'data', payload: buf.subarray(pos + 4, pos + len), next: pos + len };
}

function sideband(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < data.length; off += 32768) {
    const chunk = data.subarray(off, Math.min(data.length, off + 32768));
    out.push(pktLineBand1(chunk));
  }
  if (data.length === 0) out.push(pktLineBand1(Buffer.alloc(0)));
  return out;
}

// ---------- advertisements ----------

const ADV_V2 = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

export function advertisementV2(): Buffer {
  return ADV_V2;
}

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function peeledOf(oid: string): string | null {
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const text = obj.data.toString('utf8');
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  return first.startsWith('object ') ? first.slice(7, 47) : null;
}

export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const cacheKey = `v0:${service}`;
  if (service === 'git-upload-pack') {
    const hit = repo.advCache.get(cacheKey);
    if (hit) return hit;
  }
  const caps = service === 'git-upload-pack'
    ? 'side-band-64k symref=HEAD:refs/heads/main'
    : 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const mainTip = repo.refs.get('refs/heads/main');
  const lines: string[] = [];
  if (repo.refs.size === 0) {
    lines.push(`${ZERO_OID} HEAD\0${caps}\n`);
    lines.push(`${ZERO_OID} capabilities^{}\n`);
  } else {
    const headOid = mainTip ?? repo.refs.values().next().value as string;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const ref of sortedRefNames(repo)) {
      const oid = repo.refs.get(ref) as string;
      lines.push(`${oid} ${ref}\n`);
      const peeled = peeledOf(oid);
      if (peeled) lines.push(`${peeled} ${ref}^{}\n`);
    }
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  if (service === 'git-upload-pack') repo.advCache.set(cacheKey, out);
  return out;
}

// ---------- ls-refs ----------

export function lsRefs(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean, unborn: boolean): Buffer {
  const cacheKey = `ls:${prefixes.join(',')}:${peel ? 1 : 0}:${symrefs ? 1 : 0}:${unborn ? 1 : 0}`;
  const hit = repo.lsCache.get(cacheKey);
  if (hit) return hit;
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (mainTip) {
    if (matches('HEAD')) {
      let line = `${mainTip} HEAD`;
      if (symrefs) line += ' symref-target:refs/heads/main';
      lines.push(`${line}\n`);
    }
  } else if (unborn && matches('HEAD')) {
    let line = 'unborn HEAD';
    if (symrefs) line += ' symref-target:refs/heads/main';
    lines.push(`${line}\n`);
  }
  for (const ref of sortedRefNames(repo)) {
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref) as string;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peeledOf(oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const parts = lines.map((l) => pktLine(l));
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  repo.lsCache.set(cacheKey, out);
  return out;
}

// ---------- fetch ----------

function addTreeClosure(treeOid: string, include: Set<string>, order: string[], excluded: Set<string>): void {
  if (excluded.has(treeOid) || include.has(treeOid)) return;
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  include.add(treeOid);
  order.push(treeOid);
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') addTreeClosure(e.oid, include, order, excluded);
    else if (!excluded.has(e.oid) && !include.has(e.oid)) {
      include.add(e.oid);
      order.push(e.oid);
    }
  }
}

function haveClosure(haves: string[], shallowSet: Set<string> = new Set()): Set<string> {
  const excluded = new Set<string>();
  const queue: string[] = [];
  const addTree = (treeOid: string): void => {
    if (excluded.has(treeOid)) return;
    const obj = objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    excluded.add(treeOid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') addTree(e.oid);
      else excluded.add(e.oid);
    }
  };
  for (const h of haves) {
    if (objects.has(h) && !excluded.has(h)) queue.push(h);
  }
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (excluded.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    excluded.add(oid);
    if (obj.type === 'commit') {
      if (obj.tree) addTree(obj.tree);
      // A shallow boundary commit's ancestry is NOT held, even when the
      // client lists the boundary itself as a have.
      if (shallowSet.has(oid)) continue;
      for (const p of obj.parents) if (!excluded.has(p)) queue.push(p);
    } else if (obj.type === 'tag') {
      const target = peeledOf(oid);
      if (target && !excluded.has(target)) queue.push(target);
    } else if (obj.type === 'tree') {
      addTree(oid);
    }
  }
  return excluded;
}

/**
 * Everything a shallow client demonstrably holds in the region between
 * the wants and its shallow boundaries: those commits and their trees.
 * Used only to avoid re-sending held objects on a deepen fetch; the
 * generation counting still runs from the wants.
 */
function heldShallowClosure(wants: string[], shallowSet: Set<string>): Set<string> {
  const held = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [];
  for (const want of wants) {
    const obj = objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      held.add(want);
      const target = peeledOf(want);
      if (target) queue.push(target);
    } else if (obj.type === 'commit') {
      queue.push(want);
    }
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    held.add(oid);
    if (obj.tree) addTreeClosure(obj.tree, held, order, new Set());
    if (shallowSet.has(oid)) continue;
    for (const p of obj.parents) queue.push(p);
  }
  return held;
}

interface FetchPlan {
  oids: string[];
  boundaries: string[];
}

function planFetch(wants: string[], haves: string[], deepen: number | null, shallow: string[] = []): FetchPlan {
  const shallowSet = new Set(shallow);
  // Exclusion = what the client demonstrably holds: its haves (with
  // ancestry, except below a shallow boundary) plus the shallow boundary
  // commits themselves with their trees. A want that is a brand-new tip
  // is in neither set, so it is always delivered; a shallow boundary is
  // never re-sent, but the walk passes through it — `deepen` counts
  // generations from the wants, held ones included.
  const haveExcl = haveClosure(haves, shallowSet);
  const shallowExcl = haveClosure(shallow, shallowSet);
  const excluded = new Set<string>([...haveExcl, ...shallowExcl]);
  const include = new Set<string>();
  const order: string[] = [];
  const includeOne = (oid: string): void => {
    if (!include.has(oid) && !excluded.has(oid)) {
      include.add(oid);
      order.push(oid);
    }
  };
  // Breadth-first over commits by generation from the wants.
  let frontier: string[] = [];
  for (const want of wants) {
    const obj = objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      includeOne(want);
      const target = peeledOf(want);
      if (target) frontier.push(target);
    } else if (obj.type === 'commit') {
      frontier.push(want);
    } else {
      includeOne(want);
    }
  }
  const seenCommit = new Set<string>();
  let gen = 0;
  const boundaries = new Set<string>();
  while (frontier.length > 0) {
    if (deepen !== null && gen >= deepen) break;
    const next: string[] = [];
    for (const oid of frontier) {
      if (seenCommit.has(oid)) continue;
      seenCommit.add(oid);
      const obj = objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      // A genuine have (not itself a shallow boundary) prunes the walk:
      // the client has its whole ancestry.
      if (haveExcl.has(oid) && !shallowSet.has(oid)) continue;
      includeOne(oid);
      if (obj.tree) addTreeClosure(obj.tree, include, order, excluded);
      for (const p of obj.parents) {
        const willTraverse = deepen === null || gen + 1 < deepen;
        if (willTraverse) next.push(p);
        else if (deepen !== null && !excluded.has(p) && !include.has(p)) boundaries.add(oid);
      }
    }
    frontier = next;
    gen += 1;
  }
  return { oids: order, boundaries: [...boundaries] };
}

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

export function fetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const key = [
    repo.version,
    [...args.wants].sort().join(','),
    args.deepen === null ? 'full' : String(args.deepen),
    [...args.haves].sort().join(','),
    [...args.shallow].sort().join(','),
  ].join('|');
  const hit = repo.fetchCache.get(key);
  if (hit) return hit;

  const plan = planFetch(args.wants, args.haves, args.deepen, args.shallow);
  const parts: Buffer[] = [];

  // acknowledgments section
  const ackLines: string[] = [];
  if (args.haves.length === 0) {
    ackLines.push('NAK\n');
  } else {
    for (const h of args.haves) {
      if (objects.has(h)) ackLines.push(`ACK ${h}\n`);
    }
    if (ackLines.length === 0) ackLines.push('NAK\n');
    else ackLines.push('ready\n');
  }
  parts.push(pktLine('acknowledgments\n'));
  for (const l of ackLines) parts.push(pktLine(l));
  parts.push(PKT_FLUSH);

  // shallow-info section
  const hasShallowWork = args.deepen !== null || args.shallow.length > 0;
  if (hasShallowWork) {
    const included = new Set(plan.oids);
    const lines: string[] = [];
    for (const b of plan.boundaries) lines.push(`shallow ${b}\n`);
    for (const old of args.shallow) {
      const obj = objects.get(old);
      let unshallowed = false;
      if (obj && obj.type === 'commit') {
        for (const p of obj.parents) if (included.has(p)) unshallowed = true;
      }
      if (unshallowed) lines.push(`unshallow ${old}\n`);
      else if (args.deepen === null) lines.push(`unshallow ${old}\n`);
      else if (!plan.boundaries.includes(old)) lines.push(`shallow ${old}\n`);
    }
    if (lines.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const l of lines) parts.push(pktLine(l));
      parts.push(PKT_FLUSH);
    }
  }

  // packfile section
  const pack = buildPack(plan.oids);
  parts.push(pktLine('packfile\n'));
  for (const s of sideband(pack)) parts.push(s);
  parts.push(PKT_FLUSH);

  const out = Buffer.concat(parts);
  repo.fetchCache.set(key, out);
  return out;
}

/** v0 fetch: NAK then the sideband pack, no sections. */
export function fetchResponseV0(repo: Repo, wants: string[], haves: string[]): Buffer {
  const plan = planFetch(wants, haves, null, []);
  const pack = buildPack(plan.oids);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of sideband(pack)) parts.push(s);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------- receive-pack ----------

/** True when oldOid is an ancestor of (or equal to) newOid. */
export function isAncestor(oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const start = objects.get(newOid);
  if (!start || start.type !== 'commit') return false;
  if (start.parents.includes(oldOid)) return true;
  const oldGen = commitGen(oldOid);
  const visited = new Set<string>();
  const stack: string[] = [...start.parents];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === oldOid) return true;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (commitGen(oid) < oldGen) continue;
    for (const p of obj.parents) stack.push(p);
  }
  return false;
}

export interface RefUpdate { oldOid: string; newOid: string; ref: string }

export function receivePack(repo: Repo, updates: RefUpdate[], packAt: number, body: Buffer): Buffer {
  let unpackLine = 'unpack ok\n';
  if (packAt < body.length && body.length - packAt >= 12) {
    try {
      parsePack(body, packAt);
    } catch {
      unpackLine = 'unpack index-pack failed\n';
    }
  }
  const lines: string[] = [unpackLine];
  let moved = false;
  for (const u of updates) {
    const current = repo.refs.get(u.ref);
    if (u.newOid === ZERO_OID) {
      // delete
      if (current !== undefined && current === u.oldOid) {
        repo.refs.delete(u.ref);
        moved = true;
        lines.push(`ok ${u.ref}\n`);
      } else {
        lines.push(`ng ${u.ref} non-fast-forward\n`);
      }
    } else if (u.oldOid === ZERO_OID) {
      // create
      if (current !== undefined) {
        lines.push(`ng ${u.ref} already exists\n`);
      } else {
        repo.refs.set(u.ref, u.newOid);
        moved = true;
        lines.push(`ok ${u.ref}\n`);
      }
    } else {
      // update
      if (current === undefined || current !== u.oldOid) {
        lines.push(`ng ${u.ref} non-fast-forward\n`);
      } else if (isAncestor(u.oldOid, u.newOid)) {
        repo.refs.set(u.ref, u.newOid);
        moved = true;
        lines.push(`ok ${u.ref}\n`);
      } else {
        lines.push(`ng ${u.ref} non-fast-forward\n`);
      }
    }
  }
  if (moved || unpackLine === 'unpack ok\n') bumpRepo(repo);
  const parts: Buffer[] = [];
  for (const l of lines) parts.push(pktLineBand1(Buffer.from(l, 'utf8')));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------- merge ----------

export function mergeBase(a: string, b: string): string | null {
  const ancestorsOfA = new Map<string, number>();
  const stack: string[] = [a];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (ancestorsOfA.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    ancestorsOfA.set(oid, commitGen(oid));
    for (const p of obj.parents) stack.push(p);
  }
  let best: string | null = null;
  let bestGen = -1;
  const seen = new Set<string>();
  const walk: string[] = [b];
  while (walk.length > 0) {
    const oid = walk.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const g = ancestorsOfA.get(oid);
    if (g !== undefined && g > bestGen) { best = oid; bestGen = g; }
    if (commitGen(oid) <= bestGen) continue;
    for (const p of obj.parents) walk.push(p);
  }
  return best;
}

export interface MergeOutcome { conflict: boolean; files: Map<string, string> }

export function threeWayMerge(repo: Repo, baseRef: string, headRef: string): MergeOutcome | null {
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  if (!baseTip || !headTip) return null;
  const mb = mergeBase(headTip, baseTip);
  if (!mb) return null;
  const mbCommit = objects.get(mb);
  if (!mbCommit) return null;
  const flatten = (commitOid: string): Map<string, string> => {
    const out = new Map<string, string>();
    const commit = objects.get(commitOid);
    if (commit && commit.tree) {
      const flat = new Map<string, FileEnt>();
      flattenInto(commit.tree, '', flat);
      for (const [path, ent] of flat) out.set(path, ent.blob);
    }
    return out;
  };
  const baseFiles = flatten(mb);
  const ourFiles = flatten(baseTip);
  const theirFiles = flatten(headTip);
  const merged = new Map<string, string>();
  const paths = new Set<string>([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
  let conflict = false;
  for (const path of paths) {
    const anc = baseFiles.get(path);
    const ours = ourFiles.get(path);
    const theirs = theirFiles.get(path);
    if (ours === theirs) {
      if (ours !== undefined) merged.set(path, ours);
    } else if (anc === ours) {
      if (theirs !== undefined) merged.set(path, theirs);
    } else if (anc === theirs) {
      if (ours !== undefined) merged.set(path, ours);
    } else {
      conflict = true;
    }
  }
  return { conflict, files: merged };
}
