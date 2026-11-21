import { promises } from 'fs'
import { dirname, join } from 'path'
import { inject, injectable } from 'inversify'
import { Logger } from 'winston'

import { FileUploaderInterface } from '../../Domain/Services/FileUploaderInterface'
import { UploadChunkResult } from '../../Domain/Upload/UploadChunkResult'
import TYPES from '../../Bootstrap/Types'
import { ChunkId } from '../../Domain/Upload/ChunkId'

@injectable()
export class FSFileUploader implements FileUploaderInterface {
  /**
   * Chunks are written to "<file>.chunks/<chunkId>" as they arrive (they used to be held in memory
   * until the upload finished, and forever when it never did). A chunk sent again replaces the
   * earlier copy. The home server's daily jobs remove the folders of uploads that never finished.
   */
  static readonly CHUNKS_DIRECTORY_SUFFIX = '.chunks'

  constructor(
    @inject(TYPES.Files_FILE_UPLOAD_PATH) private fileUploadPath: string,
    @inject(TYPES.Files_Logger) private logger: Logger,
  ) {}

  async uploadFileChunk(dto: {
    uploadId: string
    data: Uint8Array
    filePath: string
    chunkId: ChunkId
    unencryptedFileSize: number
  }): Promise<string> {
    const chunksDirectory = this.chunksDirectory(dto.uploadId)
    await promises.mkdir(chunksDirectory, { recursive: true })

    const alreadyStoredBytes = await this.accumulatedEncryptedFileSize(chunksDirectory, dto.chunkId)
    if (alreadyStoredBytes >= dto.unencryptedFileSize) {
      throw new Error(
        `Could not finish chunk upload. Accumulated encrypted file size (${alreadyStoredBytes}B) already exceeds the unecrypted file size: ${dto.unencryptedFileSize}`,
      )
    }

    this.logger.debug(`FS storing file chunk ${dto.chunkId} for ${dto.uploadId}: ${dto.data.byteLength}B`)

    await promises.writeFile(join(chunksDirectory, String(dto.chunkId)), dto.data)

    return dto.uploadId
  }

  async finishUploadSession(
    uploadId: string,
    filePath: string,
    _uploadChunkResults: UploadChunkResult[],
  ): Promise<void> {
    this.logger.debug(`FS finishing upload for ${uploadId}`)

    const chunksDirectory = this.chunksDirectory(uploadId)
    const chunkNames = await promises.readdir(chunksDirectory).catch(() => [] as string[])
    if (chunkNames.length === 0) {
      throw new Error(`Could not find chunks for upload ${uploadId}`)
    }

    const orderedChunkIds = chunkNames.map(Number).sort((a, b) => a - b)
    const filePathOnDisk = `${this.fileUploadPath}/${filePath}`
    // Written from scratch (not appended to), so a failed earlier attempt can't leave data before it.
    await promises.writeFile(filePathOnDisk, new Uint8Array(0))
    for (const chunkId of orderedChunkIds) {
      const chunk = await promises.readFile(join(chunksDirectory, String(chunkId)))
      if (chunk.byteLength === 0) {
        throw new Error(`Could not find chunk ${chunkId} for upload ${uploadId}`)
      }

      this.logger.debug(`FS writing chunk ${chunkId} for ${uploadId}: ${chunk.byteLength}B`)

      await promises.appendFile(filePathOnDisk, chunk)
    }

    await promises.rm(chunksDirectory, { recursive: true, force: true })
  }

  async createUploadSession(filePath: string): Promise<string> {
    const fullPath = `${this.fileUploadPath}/${filePath}`

    await promises.mkdir(dirname(fullPath), { recursive: true })

    return fullPath
  }

  private chunksDirectory(uploadId: string): string {
    return `${uploadId}${FSFileUploader.CHUNKS_DIRECTORY_SUFFIX}`
  }

  private async accumulatedEncryptedFileSize(chunksDirectory: string, exceptChunkId: ChunkId): Promise<number> {
    let accumulatedSize = 0

    for (const chunkName of await promises.readdir(chunksDirectory)) {
      if (chunkName === String(exceptChunkId)) {
        continue
      }
      accumulatedSize += (await promises.stat(join(chunksDirectory, chunkName))).size
    }

    return accumulatedSize
  }
}
