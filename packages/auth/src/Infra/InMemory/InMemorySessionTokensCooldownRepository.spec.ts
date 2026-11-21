import { Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { InMemorySessionTokensCooldownRepository } from './InMemorySessionTokensCooldownRepository'

describe('InMemorySessionTokensCooldownRepository', () => {
  const logger = { debug: jest.fn() } as unknown as Logger
  const sessionUuid = Uuid.create('00000000-0000-4000-8000-000000000001').getValue()
  const otherSessionUuid = Uuid.create('00000000-0000-4000-8000-000000000002').getValue()
  let now: number

  const createRepository = () => new InMemorySessionTokensCooldownRepository(logger, () => now)

  beforeEach(() => {
    now = 1_000_000
  })

  it('returns the previous tokens during the cooldown', async () => {
    const repository = createRepository()
    await repository.setCooldown({
      sessionUuid,
      hashedAccessToken: 'access',
      hashedRefreshToken: 'refresh',
      cooldownPeriodInSeconds: 10,
    })

    now += 9_000

    expect(await repository.getHashedTokens(sessionUuid)).toEqual({
      hashedAccessToken: 'access',
      hashedRefreshToken: 'refresh',
    })
    expect(await repository.getHashedTokens(otherSessionUuid)).toBeNull()
  })

  it('forgets the tokens once the cooldown is over', async () => {
    const repository = createRepository()
    await repository.setCooldown({
      sessionUuid,
      hashedAccessToken: 'access',
      hashedRefreshToken: 'refresh',
      cooldownPeriodInSeconds: 10,
    })

    now += 10_000

    expect(await repository.getHashedTokens(sessionUuid)).toBeNull()
  })

  it('drops expired cooldowns of other sessions when setting a new one', async () => {
    const repository = createRepository()
    await repository.setCooldown({
      sessionUuid,
      hashedAccessToken: 'a',
      hashedRefreshToken: 'r',
      cooldownPeriodInSeconds: 1,
    })
    now += 5_000
    await repository.setCooldown({
      sessionUuid: otherSessionUuid,
      hashedAccessToken: 'a2',
      hashedRefreshToken: 'r2',
      cooldownPeriodInSeconds: 10,
    })

    expect(await repository.getHashedTokens(sessionUuid)).toBeNull()
    expect(await repository.getHashedTokens(otherSessionUuid)).toEqual({
      hashedAccessToken: 'a2',
      hashedRefreshToken: 'r2',
    })
  })

  it('uses the current time by default', async () => {
    const repository = new InMemorySessionTokensCooldownRepository(logger)
    await repository.setCooldown({
      sessionUuid,
      hashedAccessToken: 'a',
      hashedRefreshToken: 'r',
      cooldownPeriodInSeconds: 60,
    })

    expect(await repository.getHashedTokens(sessionUuid)).not.toBeNull()
  })
})
