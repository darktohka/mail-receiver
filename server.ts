import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import { createWriteStream, PathLike } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { DateTime } from 'luxon';
import mailparser from 'mailparser';
import sanitize from 'sanitize-filename';
import {
  SMTPServer,
  SMTPServerAddress,
  SMTPServerDataStream,
  SMTPServerSession
} from 'smtp-server';

dotenv.config();

const app = express();
const { simpleParser } = mailparser;
const API_KEY = process.env.API_KEY;
const EMAIL_DOMAINS = (process.env.EMAIL_DOMAIN || '').split(',');
const EMAIL_ACCOUNT_PREFIX = process.env.EMAIL_ACCOUNT_PREFIX || '';
const ADMIN_APP_PORT = process.env.ADMIN_APP_PORT;

type IndexType = {
  name: string;
  messages: TransactionSummary[];
};

type TransactionSummary = {
  recipientFolderPath: string;
  messageId: string;
  processedAt: string;
  from?: string;
  subject?: string;
  filename: string;
  error?: Error;
  writeErr?: Error;
};

const SERVER_PORT = 25;

const sanitizeOptions = { replacement: '-' };

const onConnect = (session: SMTPServerSession, callback: () => void) => {
  console.log(`Connection from ${session.remoteAddress} received`);
  return callback(); // Accept the connection
};

const onRcptTo = (
  address: SMTPServerAddress,
  session: SMTPServerSession,
  callback: (_err?: Error) => void
) => {
  const recipientAddress = address.address.toLowerCase();

  if (
    recipientAddress.startsWith(EMAIL_ACCOUNT_PREFIX) &&
    EMAIL_DOMAINS.find((domain) =>
      recipientAddress.endsWith(domain.toLocaleLowerCase())
    ) !== undefined
  ) {
    console.log(`Email #${session.id} to "${address.address}" accepted`);
    return callback(); // Accept the address
  }
  console.log(`Email #${session.id} to "${address.address}" refused`);
  return callback(new Error('No thank you'));
};

const onData = async (
  stream: SMTPServerDataStream,
  session: SMTPServerSession,
  callback: () => void
) => {
  //stream.pipe(process.stdout) // print message to console
  const recipientFolderPath = `mail/${sanitize(
    session.envelope.rcptTo[0].address,
    sanitizeOptions
  )}/`;

  await createRecipientDirectory(recipientFolderPath);
  const transactionSummary = await handleMessageStream(
    recipientFolderPath,
    session.id,
    stream
  );

  if (transactionSummary.error) {
    console.log(
      `Failed to parse email #${session.id}: ${transactionSummary.error}`
    );
  } else if (transactionSummary.writeErr) {
    console.log(
      `Failed to save email #${session.id}: ${transactionSummary.writeErr}`
    );
  } else {
    console.log(
      `Email #${session.id} parsed and saved successfully. Updating weekly index...`
    );
    await updateOrCreateWeeklyMessageIndex(transactionSummary);
  }

  console.log(`Done with #${session.id}`);
  stream.on('end', callback);
};

const server = new SMTPServer({
  onConnect,
  onRcptTo,
  onData,
  authOptional: true
});

server.on('error', (err) => {
  console.log(`Error: ${err.message}`);
});

server.listen(SERVER_PORT, '', () => {
  console.log(`SMTP listening on ${SERVER_PORT}`);
});

const createRecipientDirectory = (recipientFolderPath: PathLike) =>
  mkdir(recipientFolderPath, { recursive: true });

const handleMessageStream = async (
  recipientFolderPath: string,
  messageId: string,
  stream: SMTPServerDataStream
): Promise<TransactionSummary> => {
  return new Promise((resolve) => {
    const transactionTime = DateTime.utc();
    const transactionSummary: TransactionSummary = {
      recipientFolderPath,
      messageId,
      processedAt: transactionTime.toISO(),
      filename: ''
    };
    const messageLabel = `${transactionTime.toISO()}-${messageId}`;
    const rawFileStream = createWriteStream(
      `${recipientFolderPath}${messageLabel}.raw`
    );
    stream.pipe(rawFileStream);
    simpleParser(stream, {}, (parseErr, parsed) => {
      let filename;
      let body;
      if (parseErr) {
        filename = `${recipientFolderPath}${messageLabel}.err`;
        body = JSON.stringify(parseErr, null, '  ');
        transactionSummary.error = parseErr;
      } else {
        filename = `${recipientFolderPath}${messageLabel}.json`;
        body = JSON.stringify(parsed, null, '  ');

        if (parsed.from) {
          transactionSummary.from = parsed.from.value[0].address;
        }

        transactionSummary.subject = parsed.subject;
        transactionSummary.filename = `${messageLabel}.json`;
      }
      writeFile(filename, body)
        .catch((writeErr) => {
          transactionSummary.writeErr = writeErr;
          console.log(`Failed to write email to file:`, writeErr);
        })
        .then(() => {
          resolve(transactionSummary);
        });
    });
  });
};

const updateOrCreateWeeklyMessageIndex = async (
  transactionSummary: TransactionSummary
) => {
  const processedAt = DateTime.fromISO(transactionSummary.processedAt);
  const indexName = `w${processedAt.weekNumber}-${processedAt.year}`;
  const existingIndex = await loadWeeklyIndex(indexName);
  const newIndex = {
    ...existingIndex,
    messages: [transactionSummary, ...existingIndex.messages]
  };
  return saveWeeklyIndex(newIndex);
};

const loadWeeklyIndex = async (indexName: string): Promise<IndexType> => {
  let index = { name: indexName, messages: [] };

  try {
    const existingData = await readFile(`mail/${indexName}.json`, 'utf-8');
    index = JSON.parse(existingData);
  } catch {
    console.log(`No index found for ${indexName}.`);
  }

  return index;
};

const saveWeeklyIndex = (index: IndexType) =>
  writeFile(`mail/${index.name}.json`, JSON.stringify(index, null, '  '));

const loadMessage = async (
  domain: string,
  username: string,
  messageFilename: string
) => {
  const recipientFolderPath = `mail/${sanitize(
    `${username}@${domain}`,
    sanitizeOptions
  )}/${messageFilename}`;

  try {
    const existingData = await readFile(recipientFolderPath, 'utf-8');
    const content = JSON.parse(existingData);
    return { domain, username, messageFilename, ...content };
  } catch {
    return null;
  }
};

const startAdminAPI = (port: number, apiKey: string) => {
  const checkApiKey = (req: Request, res: Response, next: NextFunction) => {
    const submittedAPIKey = req.query.api_key as string;

    if (!submittedAPIKey || submittedAPIKey.trim() !== apiKey) {
      res.status(401);
      res.json({ message: 'Access denied' });
    } else {
      next();
    }
  };

  app.use(checkApiKey);

  app.get('/api/mail', async (_req: Request, res: Response) => {
    const now = DateTime.utc();
    const currentWeek = now.weekNumber;
    const currentYear = now.year;

    res.redirect(`/api/mail/${currentYear}/${currentWeek}`);
  });

  app.get(
    '/api/mail/:year([0-9]{4})/:week([0-9]{1,2})',
    async (req: Request, res: Response) => {
      const weekNumber = parseInt(req.params.week);
      const year = parseInt(req.params.year);
      const indexName = `w${weekNumber}-${year}`;
      const index = await loadWeeklyIndex(indexName);

      const indexWithMessageUrls = index.messages.map((message) => {
        const recipient = message.recipientFolderPath
          .replace('mail/', '')
          .slice(0, -1);
        const username = recipient.split('@')[0];
        const domain = recipient.split('@')[1];
        return {
          ...message,
          recipientFolderPath: null,
          recipient,
          message: {
            href: `/api/mail/${encodeURIComponent(domain)}/${encodeURIComponent(
              username
            )}/${encodeURIComponent(message.filename)}`
          }
        };
      });

      res.json(indexWithMessageUrls);
    }
  );

  app.get('/api/mail/:domain/:username/:messageFilename', async (req, res) => {
    const message = await loadMessage(
      req.params.domain,
      req.params.username,
      req.params.messageFilename
    );

    if (!message) {
      res.status(404);
      res.json({ message: 'Not Found' });
    } else {
      res.json(message);
    }
  });

  app.listen(port, () => {
    console.log(`Admin app listening on ${port}`);
  });
};

if (!ADMIN_APP_PORT || !API_KEY || API_KEY.length < 20) {
  console.log(
    `Admin API settings missing or incomplete. Admin API will not be enabled.`
  );
  console.log(`To enable Admin API, add to settings to .env file:`);
  console.log(`  ADMIN_APP_PORT=2255`);
  console.log(`  API_KEY=<security key of at least 20 chars>`);
} else {
  startAdminAPI(parseInt(ADMIN_APP_PORT, 10), API_KEY);
}
