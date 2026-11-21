import { DomainEventHandlerInterface, DomainEventInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { DirectCallEventMessageHandler } from './DirectCallEventMessageHandler'

describe('DirectCallEventMessageHandler', () => {
  let handler: DomainEventHandlerInterface
  let logger: Logger
  const event = { type: 'TEST_EVENT', payload: {} } as unknown as DomainEventInterface

  const createMessageHandler = () => new DirectCallEventMessageHandler(new Map([['TEST_EVENT', handler]]), logger)

  beforeEach(() => {
    handler = { handle: jest.fn() } as unknown as DomainEventHandlerInterface
    logger = { debug: jest.fn(), error: jest.fn() } as unknown as Logger
  })

  it('passes the event to its handler', async () => {
    await createMessageHandler().handleMessage(event)

    expect(handler.handle).toHaveBeenCalledWith(event)
  })

  it('ignores events without a handler', async () => {
    await createMessageHandler().handleMessage({ type: 'OTHER_EVENT', payload: {} } as unknown as DomainEventInterface)

    expect(handler.handle).not.toHaveBeenCalled()
  })

  it('logs a failing handler instead of failing the publisher', async () => {
    handler.handle = jest.fn().mockRejectedValue(new Error('SQLITE_BUSY'))

    await expect(createMessageHandler().handleMessage(event)).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith('Event handler for TEST_EVENT failed: SQLITE_BUSY', expect.anything())
  })

  it('does not support string messages', async () => {
    await expect(createMessageHandler().handleMessage('message')).rejects.toThrow()
  })

  it('logs errors', async () => {
    await createMessageHandler().handleError(new Error('Oops'))

    expect(logger.error).toHaveBeenCalled()
  })
})
