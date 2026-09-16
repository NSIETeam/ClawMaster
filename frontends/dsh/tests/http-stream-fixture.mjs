/** Actual incomplete uploads must receive their response and a server-owned socket close. */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

/**
 * Leave a chunked request open and wait for the server to close it after its full refusal.
 * @param {string} url Actual local HTTP route under test.
 * @param {string} body Initial bytes; the client deliberately never ends the upload.
 * @returns {Promise<{ status: number, body: string }>} Complete refusal after server disconnection.
 */
export async function receiveStreamingRefusal(url, body) {
  let request, deadline;
  try {
    return await new Promise((resolve, reject) => {
      let result, closed = false;
      const finish = () => { if (result && closed) resolve(result); };
      request = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'keep-alive' } }, response => {
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 4096) { reject(new Error('Stream refusal exceeded its small-response allowance')); return; }
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            assert.equal(response.headers.connection, 'close');
            assert.equal(response.complete, true, 'The refusal must be complete before disconnecting');
            result = { status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') };
            finish();
          } catch (error) { reject(error); }
        });
      });
      request.once('error', reject);
      request.once('socket', socket => socket.once('close', () => {
        closed = true;
        if (!result) reject(new Error('Server closed the socket before the complete refusal arrived'));
        else finish();
      }));
      deadline = setTimeout(() => reject(new Error('Server did not complete and close the refused upload')), 5000);
      request.write(body);
    });
  } finally {
    clearTimeout(deadline);
    request?.destroy();
  }
}
