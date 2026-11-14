/**
 * Minimal SMTP stub used only for verification and automated tests.
 * It accepts one message per DATA block and prints the envelope, so mail
 * delivery can be exercised locally without a real provider.
 *
 *   node backend/tests/smtp-stub.mjs 2525
 */
import net from 'node:net';

const port = Number(process.argv[2] ?? 2525);

const server = net.createServer((socket) => {
  let buffer = '';
  let inData = false;
  let data = '';
  let recipients = [];
  let sender = '';

  socket.setEncoding('utf8');
  socket.write('220 localhost ESMTP workforce-stub\r\n');

  socket.on('data', (chunk) => {
    buffer += chunk;

    if (inData) {
      data += buffer;
      buffer = '';
      const end = data.indexOf('\r\n.\r\n');
      if (end === -1) return;
      const body = data.slice(0, end);
      data = '';
      inData = false;
      console.log(`[smtp-stub] message from=${sender} to=${recipients.join(',')} bytes=${body.length}`);
      recipients = [];
      socket.write('250 2.0.0 Ok: queued as stub\r\n');
      return;
    }

    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const upper = line.toUpperCase();

      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        socket.write('250-localhost\r\n250-SIZE 10485760\r\n250-8BITMIME\r\n250 HELP\r\n');
      } else if (upper.startsWith('MAIL FROM')) {
        sender = line.slice(line.indexOf(':') + 1).trim();
        socket.write('250 2.1.0 Ok\r\n');
      } else if (upper.startsWith('RCPT TO')) {
        recipients.push(line.slice(line.indexOf(':') + 1).trim());
        socket.write('250 2.1.5 Ok\r\n');
      } else if (upper === 'DATA') {
        inData = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (upper === 'RSET') {
        socket.write('250 2.0.0 Ok\r\n');
      } else if (upper === 'NOOP') {
        socket.write('250 2.0.0 Ok\r\n');
      } else if (upper === 'QUIT') {
        socket.write('221 2.0.0 Bye\r\n');
        socket.end();
      } else {
        socket.write('250 2.0.0 Ok\r\n');
      }
    }
  });

  socket.on('error', () => undefined);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[smtp-stub] listening on 127.0.0.1:${port}`);
});
