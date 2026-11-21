import { Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'
import { SessionTokensCooldownRepositoryInterface } from '../../Domain/Session/SessionTokensCooldownRepositoryInterface'

/**
 * Keeps a session's previous tokens valid for a short cooldown after they were refreshed, as the
 * Redis repository does: a client whose refresh response got lost (an app suspended mid-request,
 * two tabs refreshing at once) can still use them instead of being signed out. In memory, for the
 * single-process home server: a restart forgets the cooldowns, which only last seconds.
 */
export class InMemorySessionTokensCooldownRepository implements SessionTokensCooldownRepositoryInterface {
  private cooldowns = new Map<string, { hashedAccessToken: string; hashedRefreshToken: string; expiresAt: number }>()

  constructor(
    private logger: Logger,
    private now: () => number = Date.now,
  ) {}

  async getHashedTokens(sessionUuid: Uuid): Promise<{ hashedAccessToken: string; hashedRefreshToken: string } | null> {
    const cooldown = this.cooldowns.get(sessionUuid.value)
    if (cooldown === undefined) {
      return null
    }
    if (cooldown.expiresAt <= this.now()) {
      this.cooldowns.delete(sessionUuid.value)

      return null
    }

    return { hashedAccessToken: cooldown.hashedAccessToken, hashedRefreshToken: cooldown.hashedRefreshToken }
  }

  async setCooldown(dto: {
    sessionUuid: Uuid
    hashedAccessToken: string
    hashedRefreshToken: string
    cooldownPeriodInSeconds: number
  }): Promise<void> {
    this.removeExpired()
    this.cooldowns.set(dto.sessionUuid.value, {
      hashedAccessToken: dto.hashedAccessToken,
      hashedRefreshToken: dto.hashedRefreshToken,
      expiresAt: this.now() + dto.cooldownPeriodInSeconds * 1000,
    })
    this.logger.debug(`Session tokens cooldown set for ${dto.cooldownPeriodInSeconds}s`)
  }

  private removeExpired(): void {
    const now = this.now()
    for (const [sessionUuid, cooldown] of this.cooldowns) {
      if (cooldown.expiresAt <= now) {
        this.cooldowns.delete(sessionUuid)
      }
    }
  }
}
