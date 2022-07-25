import { SMTPServer } from 'smtp-server'
import mailparser from 'mailparser'
import { createWriteStream, writeFile } from 'fs'

const { simpleParser } = mailparser
const API_KEY = process.env.API_KEY
const EMAIL_DOMAINS = (process.env.EMAIL_DOMAIN || '').split(',')
const EMAIL_ACCOUNT_PREFIX = process.env.EMAIL_ACCOUNT_PREFIX

if (!API_KEY || API_KEY.length < 8) {
  throw new Error('ADMIN_USER_PASSWORD of 8 characters or more is required')
}

const SERVER_PORT = 25

const server = new SMTPServer({
  onConnect,
  onRcptTo,
  onData,
  authOptional: true
})

server.on('error', (err) => {
  console.log(`Error: ${err.message}`)
})
server.listen(SERVER_PORT, null, () => {
  console.log(`Listenning on ${SERVER_PORT}`)
})

function onConnect(session, callback) {
  console.log(`Connection from ${session.remoteAddress} received`)
  return callback() // Accept the connection
}

function onRcptTo(address, session, callback) {
  const recipientAddress = address.address.toLowerCase()

  if (
    recipientAddress.startsWith(EMAIL_ACCOUNT_PREFIX) &&
    EMAIL_DOMAINS.find((domain) =>
      recipientAddress.endsWith(domain.toLocaleLowerCase())
    ) !== undefined
  ) {
    console.log(`Email to ${address.address} accepted`)
    return callback() // Accept the address
  }
  console.log(`Email to ${address.address} refused`)
  return callback(new Error('No thank you'))
}

function onData(stream, session, callback) {
  const rawFileStream = createWriteStream(`mail/${session.id}.orig`)
  //stream.pipe(process.stdout) // print message to console
  stream.pipe(rawFileStream)
  simpleParser(stream, {}, (parseErr, parsed) => {
    let filename
    let body
    if (parseErr) {
      filename = `mail/${session.id}.err`
      body = JSON.stringify(parseErr, null, '  ')
    } else {
      filename = `mail/${session.id}.parsed`
      body = JSON.stringify(parsed, null, '  ')
    }
    writeFile(filename, body, (writeErr) => {
      if (writeErr) console.log(`Failed to write email to file:`, writeErr)
    })
  })
  stream.on('end', callback)
}
