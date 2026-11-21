import { Logger } from 'winston'

import {
  DomainEventHandlerInterface,
  DomainEventInterface,
  DomainEventMessageHandlerInterface,
} from '@standardnotes/domain-events'

export class DirectCallEventMessageHandler implements DomainEventMessageHandlerInterface {
  constructor(
    private handlers: Map<string, DomainEventHandlerInterface>,
    private logger: Logger,
  ) {}

  async handleMessage(messageOrEvent: string | DomainEventInterface): Promise<void> {
    if (typeof messageOrEvent === 'string') {
      throw new Error('DirectCallEventMessageHandler does not support string messages')
    }

    const handler = this.handlers.get(messageOrEvent.type)
    if (!handler) {
      this.logger.debug(`Event handler for event type ${messageOrEvent.type} does not exist`)

      return
    }

    this.logger.debug(`Received event: ${messageOrEvent.type}`)

    // Events are handled inline in the request that published them (home server). As with a queue,
    // a failing handler must not fail that request, which has already done its work (e.g. saved items).
    try {
      await handler.handle(messageOrEvent)
    } catch (error) {
      this.logger.error(`Event handler for ${messageOrEvent.type} failed: ${(error as Error).message}`, {
        stack: (error as Error).stack,
      })
    }
  }

  async handleError(error: Error): Promise<void> {
    this.logger.error('Error occured while handling SQS message: %O', error)
  }
}
