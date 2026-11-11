import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { BufferClient } from '../src/buffer.ts';
import { loadConfig } from '../src/config.ts';
import { ControlledPostCreationAmbiguousError, ControlledTestPostService, createConfirmation, deleteConfirmation,
  openControlledReceipt, sealControlledReceipt, type ControlledTestPostReceipt, type ControlledTestPostSpec } from '../src/controlled-test-post.ts';
import { Store } from '../src/db.ts';
import { evidencePost, sha256 } from '../src/security.ts';

function usage(): never {
  throw new Error('Usage: controlled-buffer-post.ts create <spec.json> <receipt.txt> | inspect <receipt.txt> | delete <receipt.txt>');
}

const [operation, firstPath, secondPath] = process.argv.slice(2);
if (!operation || !firstPath) usage();
const config = loadConfig();
const store = new Store(config.databasePath);
const buffer = new BufferClient(config, store);
const service = new ControlledTestPostService(store, buffer);
const prompt = createInterface({ input: stdin, output: stdout });

function saveReceipt(path: string, receipt: ControlledTestPostReceipt): void {
  if (existsSync(path)) throw new Error('Receipt path already exists; refusing to overwrite it');
  writeFileSync(path, `${sealControlledReceipt(receipt, config.cookieSecret)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function loadReceipt(path: string): ControlledTestPostReceipt {
  return openControlledReceipt(readFileSync(path, 'utf8').trim(), config.cookieSecret);
}

try {
  if (operation === 'create') {
    if (!secondPath) usage();
    if (existsSync(secondPath)) throw new Error('Receipt path already exists; creation is blocked');
    const spec = JSON.parse(readFileSync(firstPath, 'utf8')) as ControlledTestPostSpec;
    stdout.write(`${JSON.stringify({
      operation: 'create_controlled_test_post', runId: spec.runId, tenantHash: sha256(spec.tenantId),
      connectionHash: sha256(spec.connectionId), channelHash: sha256(spec.channelId), dueAt: spec.dueAt,
      originalUrlHash: sha256(spec.originalUrl), confirmationRequired: createConfirmation(spec.runId),
    }, null, 2)}\n`);
    const confirmation = await prompt.question('Type the exact creation confirmation: ');
    try {
      const result = await service.create(spec, confirmation);
      saveReceipt(secondPath, result.receipt);
      stdout.write(`${JSON.stringify({ outcome: 'confirmed', requestId: result.requestId,
        post: evidencePost(await service.inspect(result.receipt)), receiptSaved: true }, null, 2)}\n`);
    } catch (error) {
      if (error instanceof ControlledPostCreationAmbiguousError) {
        saveReceipt(secondPath, error.receipt);
        stdout.write(`${JSON.stringify({ outcome: 'ambiguous', postIdHash: sha256(error.receipt.postId), receiptSaved: true,
          instruction: 'Do not retry creation. Inspect Buffer and use the signed receipt for cleanup.' }, null, 2)}\n`);
      }
      throw error;
    }
  } else if (operation === 'inspect') {
    const receipt = loadReceipt(firstPath);
    stdout.write(`${JSON.stringify({ outcome: 'confirmed', post: evidencePost(await service.inspect(receipt)) }, null, 2)}\n`);
  } else if (operation === 'delete') {
    const receipt = loadReceipt(firstPath);
    stdout.write(`${JSON.stringify({ operation: 'delete_controlled_test_post', postIdHash: sha256(receipt.postId),
      dueAt: receipt.dueAt, confirmationRequired: deleteConfirmation(receipt.postId) }, null, 2)}\n`);
    const confirmation = await prompt.question('Type the exact deletion confirmation: ');
    const result = await service.delete(receipt, confirmation);
    const discovery = await buffer.discover(receipt.tenantId, receipt.connectionId);
    const absentFromScheduledDiscovery = !discovery.posts.some((post) => post.id === receipt.postId);
    stdout.write(`${JSON.stringify({ outcome: absentFromScheduledDiscovery ? 'api_absence_confirmed' : 'ambiguous',
      requestId: result.requestId, postIdHash: sha256(result.id), absentFromScheduledDiscovery,
      dashboardConfirmationStillRequired: true }, null, 2)}\n`);
  } else usage();
} finally {
  prompt.close();
  store.close();
}
