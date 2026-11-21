import {
  DomainEventHandlerInterface,
  DomainEventPublisherInterface,
  EmailBackupRequestedEvent,
} from '@standardnotes/domain-events'
import { EmailLevel, Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'
import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { ItemBackupServiceInterface } from '../Item/ItemBackupServiceInterface'
import { ItemRepositoryInterface } from '../Item/ItemRepositoryInterface'
import { ItemTransferCalculatorInterface } from '../Item/ItemTransferCalculatorInterface'
import { ItemQuery } from '../Item/ItemQuery'
import { getBody, getSubject } from '../Email/EmailBackupAttachmentCreated'

export class EmailBackupRequestedEventHandler implements DomainEventHandlerInterface {
  constructor(
    private primaryItemRepository: ItemRepositoryInterface,
    private itemBackupService: ItemBackupServiceInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
    private domainEventFactory: DomainEventFactoryInterface,
    private emailAttachmentMaxByteSize: number,
    private itemTransferCalculator: ItemTransferCalculatorInterface,
    private s3BackupBucketName: string,
    private logger: Logger,
  ) {}

  async handle(event: EmailBackupRequestedEvent): Promise<void> {
    await this.requestEmailWithBackupFile(event, this.primaryItemRepository)
  }

  private async requestEmailWithBackupFile(
    event: EmailBackupRequestedEvent,
    itemRepository: ItemRepositoryInterface,
  ): Promise<void> {
    const userUuidOrError = Uuid.create(event.payload.userUuid)
    if (userUuidOrError.isFailed()) {
      this.logger.error('User uuid is invalid', {
        userId: event.payload.userUuid,
        codeTag: 'EmailBackupRequestedEventHandler',
      })

      return
    }
    const userUuid = userUuidOrError.getValue()

    const itemQuery: ItemQuery = {
      userUuid: event.payload.userUuid,
      sortBy: 'updated_at_timestamp',
      sortOrder: 'ASC',
      deleted: false,
    }
    const itemContentSizeDescriptors = await itemRepository.findContentSizeForComputingTransferLimit(itemQuery)
    const itemUuidBundles = await this.itemTransferCalculator.computeItemUuidBundlesToFetch(
      itemContentSizeDescriptors,
      this.emailAttachmentMaxByteSize,
      userUuid,
    )

    // A backup split across several emails gets the account's items keys in every part, so each
    // part can be imported (decrypted) on its own. The bundles are already sized to fit an email,
    // so they aren't split again (a bundle can exceed the limit by its last item, as before).
    const itemsKeys =
      itemUuidBundles.length > 1
        ? await itemRepository.findAll({
            userUuid: event.payload.userUuid,
            contentType: 'SN|ItemsKey',
            deleted: false,
            sortBy: 'updated_at_timestamp',
            sortOrder: 'ASC',
          })
        : []

    const backupFileNames: string[] = []
    for (const itemUuidBundle of itemUuidBundles) {
      const items = await itemRepository.findAll({
        uuids: itemUuidBundle,
        sortBy: 'updated_at_timestamp',
        sortOrder: 'ASC',
      })
      const bundleUuids = new Set(itemUuidBundle)
      const missingItemsKeys = itemsKeys.filter((itemsKey) => !bundleUuids.has(itemsKey.uuid.value))

      const bundleBackupFileNames = await this.itemBackupService.backup(
        [...missingItemsKeys, ...items],
        event.payload.keyParams,
        itemUuidBundles.length > 1 ? undefined : this.emailAttachmentMaxByteSize,
      )

      backupFileNames.push(...bundleBackupFileNames)
    }

    const dateOnly = new Date().toISOString().substring(0, 10)
    let bundleIndex = 1

    for (const backupFileName of backupFileNames) {
      await this.domainEventPublisher.publish(
        this.domainEventFactory.createEmailRequestedEvent({
          body: getBody(event.payload.keyParams.identifier as string),
          level: EmailLevel.LEVELS.System,
          messageIdentifier: 'DATA_BACKUP',
          subject: getSubject(bundleIndex++, backupFileNames.length, dateOnly),
          userEmail: event.payload.keyParams.identifier as string,
          sender: 'backups@standardnotes.org',
          attachments: [
            {
              fileName: backupFileName,
              filePath: this.s3BackupBucketName,
              attachmentFileName: `SN-Data-${dateOnly}.txt`,
              attachmentContentType: 'application/json',
            },
          ],
          userUuid: event.payload.userUuid,
        }),
      )
    }

    this.logger.info('Email with backup requested for user', {
      userId: event.payload.userUuid,
    })
  }
}
