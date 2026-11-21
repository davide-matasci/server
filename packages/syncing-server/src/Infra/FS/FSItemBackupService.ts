import { KeyParamsData } from '@standardnotes/responses'
import { MapperInterface, Result } from '@standardnotes/domain-core'
import { promises } from 'fs'
import * as uuid from 'uuid'
import { Logger } from 'winston'
import { dirname } from 'path'

import { Item } from '../../Domain/Item/Item'
import { ItemBackupServiceInterface } from '../../Domain/Item/ItemBackupServiceInterface'
import { ItemBackupRepresentation } from '../../Mapping/Backup/ItemBackupRepresentation'
import { ItemHttpRepresentation } from '../../Mapping/Http/ItemHttpRepresentation'

export class FSItemBackupService implements ItemBackupServiceInterface {
  constructor(
    private fileUploadPath: string,
    private mapper: MapperInterface<Item, ItemBackupRepresentation>,
    private httpMapper: MapperInterface<Item, ItemHttpRepresentation>,
    private logger: Logger,
  ) {}

  /**
   * Writes the items as backup files (the same format as S3ItemBackupService) under
   * <upload path>/backups/, at most contentSizeLimit bytes of items each, and returns
   * their absolute paths. Whoever sends them deletes them.
   */
  async backup(items: Item[], authParams: KeyParamsData, contentSizeLimit?: number): Promise<string[]> {
    const filePaths = []
    let itemProjections: Array<ItemHttpRepresentation> = []
    let contentSizeCounter = 0
    for (const item of items) {
      const itemProjection = this.httpMapper.toProjection(item)
      const itemContentSize = Buffer.byteLength(JSON.stringify(itemProjection))

      if (
        contentSizeLimit !== undefined &&
        itemProjections.length > 0 &&
        contentSizeCounter + itemContentSize > contentSizeLimit
      ) {
        filePaths.push(await this.createBackupFile(itemProjections, authParams))
        itemProjections = []
        contentSizeCounter = 0
      }

      itemProjections.push(itemProjection)
      contentSizeCounter += itemContentSize
    }

    if (itemProjections.length > 0) {
      filePaths.push(await this.createBackupFile(itemProjections, authParams))
    }

    return filePaths
  }

  private async createBackupFile(
    itemRepresentations: ItemHttpRepresentation[],
    authParams: KeyParamsData,
  ): Promise<string> {
    const path = `${this.fileUploadPath}/backups/${uuid.v4()}.json`

    await promises.mkdir(dirname(path), { recursive: true })
    await promises.writeFile(
      path,
      JSON.stringify({
        items: itemRepresentations,
        auth_params: authParams,
      }),
    )
    this.logger.debug(`Created backup file ${path} with ${itemRepresentations.length} items`)

    return path
  }

  async dump(item: Item): Promise<Result<string>> {
    try {
      const contents = JSON.stringify({
        item: this.mapper.toProjection(item),
      })

      const path = `${this.fileUploadPath}/dumps/${uuid.v4()}`

      this.logger.debug(`Dumping item ${item.id.toString()} to ${path}`)

      await promises.mkdir(dirname(path), { recursive: true })

      await promises.writeFile(path, contents)

      const fileCreated = (await promises.stat(path)).isFile()

      if (!fileCreated) {
        return Result.fail(`Could not create dump file ${path}`)
      }

      return Result.ok(path)
    } catch (error) {
      return Result.fail(`Could not dump item: ${(error as Error).message}`)
    }
  }
}
