import { promises as fs } from 'fs'
import { isAbsolute, join, resolve, sep } from 'path'
import * as nodemailer from 'nodemailer'
import { Logger } from 'winston'

// The shapes of @standardnotes/domain-events' DomainEventInterface and EmailRequestedEventPayload.
type DomainEvent = { type: string; payload: unknown }

type EmailRequestedPayload = {
  userEmail: string
  subject: string
  body: string
  additionalStyles?: string
  attachments?: Array<{
    filePath: string
    fileName: string
    attachmentFileName: string
    attachmentContentType: string
  }>
}

export type SmtpSettings = {
  host: string
  port: number
  secure: boolean
  user?: string
  password?: string
  from: string
}

/**
 * Sends the server's EMAIL_REQUESTED events (email backups, sign-in alerts and so on) through an
 * SMTP server. In the hosted service a separate, closed-source email service does this.
 *
 * Emails go out in the background: the event is published inside requests (sign-in, settings),
 * and a slow or failing mail server must not fail them. Backup files the email attaches are
 * deleted once it was sent or failed.
 */
export class SmtpEmailSender {
  private transport: nodemailer.Transporter

  constructor(
    private settings: SmtpSettings,
    private backupDirectory: string,
    private logger: Logger,
  ) {
    this.transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: settings.user ? { user: settings.user, pass: settings.password } : undefined,
    })
  }

  static fromEnvironment(
    get: (key: string) => string | undefined,
    backupDirectory: string,
    logger: Logger,
  ): SmtpEmailSender | undefined {
    const host = get('SMTP_HOST')
    if (!host) {
      return undefined
    }
    const port = get('SMTP_PORT') ? +(get('SMTP_PORT') as string) : 587
    const user = get('SMTP_USER')

    return new SmtpEmailSender(
      {
        host,
        port,
        secure: get('SMTP_SECURE') !== undefined ? get('SMTP_SECURE') === 'true' : port === 465,
        user,
        password: get('SMTP_PASSWORD'),
        from: get('EMAIL_FROM') ?? user ?? `standardnotes@${host}`,
      },
      backupDirectory,
      logger,
    )
  }

  async handleMessage(messageOrEvent: string | DomainEvent): Promise<void> {
    if (typeof messageOrEvent === 'string' || messageOrEvent.type !== 'EMAIL_REQUESTED') {
      return
    }
    const payload = messageOrEvent.payload as EmailRequestedPayload

    void this.send(payload)
  }

  async handleError(error: Error): Promise<void> {
    this.logger.error(`Email sender error: ${error.message}`)
  }

  private async send(payload: EmailRequestedPayload): Promise<void> {
    // Backup files from FSItemBackupService have absolute paths; S3 ones are a bucket and a key.
    const attachmentPaths = (payload.attachments ?? []).map((attachment) => {
      return isAbsolute(attachment.fileName) ? attachment.fileName : join(attachment.filePath, attachment.fileName)
    })

    try {
      const html = payload.additionalStyles ? `<style>${payload.additionalStyles}</style>${payload.body}` : payload.body

      await this.transport.sendMail({
        from: this.settings.from,
        to: payload.userEmail,
        subject: payload.subject,
        html,
        attachments: (payload.attachments ?? []).map((attachment, index) => ({
          filename: attachment.attachmentFileName,
          contentType: attachment.attachmentContentType,
          path: attachmentPaths[index],
        })),
      })

      this.logger.info(`Email sent: ${payload.subject}`, { attachments: attachmentPaths.length })
    } catch (error) {
      this.logger.error(`Could not send email "${payload.subject}": ${(error as Error).message}`)
    } finally {
      await this.removeBackupFiles(attachmentPaths)
    }
  }

  private async removeBackupFiles(paths: string[]): Promise<void> {
    const backupDirectory = resolve(this.backupDirectory) + sep
    for (const path of paths) {
      if (!resolve(path).startsWith(backupDirectory)) {
        continue
      }
      await fs.rm(path, { force: true }).catch((error: Error) => {
        this.logger.error(`Could not remove backup file ${path}: ${error.message}`)
      })
    }
  }
}
