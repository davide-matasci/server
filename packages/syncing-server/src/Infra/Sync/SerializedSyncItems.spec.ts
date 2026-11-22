import { Result } from '@standardnotes/domain-core'

import { SyncItemsDTO } from '../../Domain/UseCase/Syncing/SyncItems/SyncItemsDTO'
import { SyncItemsResponse } from '../../Domain/UseCase/Syncing/SyncItems/SyncItemsResponse'
import { SerializedSyncItems } from './SerializedSyncItems'

describe('SerializedSyncItems', () => {
  const dto = (userUuid: string) => ({ userUuid }) as SyncItemsDTO
  const tick = () => new Promise((resolve) => setImmediate(resolve))

  it('runs the syncs of one user one after the other, and of different users at the same time', async () => {
    const events: string[] = []
    const releases: Array<() => void> = []
    const syncItems = {
      execute: jest.fn(async (input: SyncItemsDTO) => {
        events.push(`start ${input.userUuid}`)
        await new Promise<void>((resolve) => releases.push(resolve))
        events.push(`end ${input.userUuid}`)

        return Result.ok({} as SyncItemsResponse)
      }),
    }
    const serialized = new SerializedSyncItems(syncItems)

    const first = serialized.execute(dto('user-1'))
    const second = serialized.execute(dto('user-1'))
    const other = serialized.execute(dto('user-2'))
    await tick()

    expect(events).toEqual(['start user-1', 'start user-2'])

    releases.shift()?.()
    await first
    await tick()
    expect(events).toEqual(['start user-1', 'start user-2', 'end user-1', 'start user-1'])

    releases.forEach((release) => release())
    await Promise.all([second, other])
    expect(syncItems.execute).toHaveBeenCalledTimes(3)
  })

  it('runs the next sync after a failed one and passes the failure on', async () => {
    const syncItems = {
      execute: jest
        .fn()
        .mockRejectedValueOnce(new Error('SQLITE_BUSY'))
        .mockResolvedValueOnce(Result.ok({} as SyncItemsResponse)),
    }
    const serialized = new SerializedSyncItems(syncItems)

    const failing = serialized.execute(dto('user-1'))
    const next = serialized.execute(dto('user-1'))

    await expect(failing).rejects.toThrow('SQLITE_BUSY')
    expect((await next).isFailed()).toBe(false)
  })
})
