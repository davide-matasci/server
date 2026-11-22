import { Result } from '@standardnotes/domain-core'

import { SyncItems } from '../../Domain/UseCase/Syncing/SyncItems/SyncItems'
import { SyncItemsDTO } from '../../Domain/UseCase/Syncing/SyncItems/SyncItemsDTO'
import { SyncItemsResponse } from '../../Domain/UseCase/Syncing/SyncItems/SyncItemsResponse'

/**
 * Runs one sync at a time per user (home server: a single process). Two overlapping syncs of the same
 * account interleave their database reads and writes: both pass the conflict check before either has
 * saved, so the later save silently overwrites the earlier one instead of being reported as a conflict,
 * and items saved by one can fall behind the other's sync token and never reach that device. A sync
 * that arrives while another of the same user runs waits for it.
 */
export class SerializedSyncItems {
  private queues = new Map<string, Promise<unknown>>()

  constructor(private syncItems: Pick<SyncItems, 'execute'>) {}

  async execute(dto: SyncItemsDTO): Promise<Result<SyncItemsResponse>> {
    const previous = this.queues.get(dto.userUuid) ?? Promise.resolve()
    const run = previous.then(() => this.syncItems.execute(dto))
    const settled = run.catch(() => undefined)
    this.queues.set(dto.userUuid, settled)

    try {
      return await run
    } finally {
      if (this.queues.get(dto.userUuid) === settled) {
        this.queues.delete(dto.userUuid)
      }
    }
  }
}
