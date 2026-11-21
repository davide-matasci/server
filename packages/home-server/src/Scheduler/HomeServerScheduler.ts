import { promises as fs } from 'fs'
import { join } from 'path'
import { interfaces } from 'inversify'
import { Logger } from 'winston'

type UseCase<T> = { execute(dto: T): Promise<{ isFailed(): boolean; getError(): string }> }

/**
 * Runs the jobs that the hosted service runs as separate scheduled processes, which a home
 * server otherwise never runs: email backups (daily, and weekly on Sundays), the daily cleanup
 * of expired sessions and session traces, and of files left behind in the upload directory by
 * uploads that never finished and history copies that failed. Times are the server's local time.
 */
export class HomeServerScheduler {
  private timer: NodeJS.Timeout | undefined
  private lastRunDay: string | undefined

  constructor(
    private container: interfaces.Container,
    private hour: number,
    private uploadPath: string,
    private logger: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(new Date()), 60_000)
    this.timer.unref()
    this.logger.info(`Scheduler started: daily jobs at ${this.hour}:00, weekly email backups on Sundays`)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  async tick(now: Date): Promise<void> {
    const day = now.toDateString()
    if (now.getHours() !== this.hour || this.lastRunDay === day) {
      return
    }
    this.lastRunDay = day

    await this.run('cleanup of session traces', 'Auth_CleanupSessionTraces', { date: now })
    await this.run('cleanup of expired sessions', 'Auth_CleanupExpiredSessions', { date: now })
    await this.removeLeftoverUploadFiles(now)
    await this.run('daily email backups', 'Auth_TriggerEmailBackupForAllUsers', { backupFrequency: 'daily' })
    if (now.getDay() === 0) {
      await this.run('weekly email backups', 'Auth_TriggerEmailBackupForAllUsers', { backupFrequency: 'weekly' })
    }
  }

  /** Removes, after a day, "<file>.chunks" folders of unfinished uploads and leftover "dumps/" files. */
  async removeLeftoverUploadFiles(now: Date): Promise<void> {
    const cutoff = now.getTime() - 24 * 60 * 60 * 1000
    let removed = 0
    try {
      for (const directory of await this.readDirectory(this.uploadPath)) {
        const directoryPath = join(this.uploadPath, directory)
        for (const entry of await this.readDirectory(directoryPath)) {
          const isLeftover = directory === 'dumps' || entry.endsWith('.chunks')
          if (!isLeftover) {
            continue
          }
          const entryPath = join(directoryPath, entry)
          if ((await fs.stat(entryPath)).mtimeMs < cutoff) {
            await fs.rm(entryPath, { recursive: true, force: true })
            removed++
          }
        }
      }
      this.logger.info(`Scheduled cleanup of leftover upload files done: ${removed} removed`)
    } catch (error) {
      this.logger.error(`Scheduled cleanup of leftover upload files failed: ${(error as Error).message}`)
    }
  }

  private async readDirectory(path: string): Promise<string[]> {
    return fs.readdir(path).catch(() => [])
  }

  private async run<T>(name: string, binding: string, dto: T): Promise<void> {
    try {
      const result = await this.container.get<UseCase<T>>(Symbol.for(binding)).execute(dto)
      if (result.isFailed()) {
        this.logger.error(`Scheduled ${name} failed: ${result.getError()}`)
      } else {
        this.logger.info(`Scheduled ${name} done`)
      }
    } catch (error) {
      this.logger.error(`Scheduled ${name} failed: ${(error as Error).message}`)
    }
  }
}
