import { Result, UseCaseInterface, Validator } from '@standardnotes/domain-core'
import { DumpRepositoryInterface } from '../../Dump/DumpRepositoryInterface'
import { CreateRevisionFromDumpDTO } from './CreateRevisionFromDumpDTO'
import { RevisionRepositoryInterface } from '../../Revision/RevisionRepositoryInterface'

export class CreateRevisionFromDump implements UseCaseInterface<void> {
  constructor(
    private dumpRepository: DumpRepositoryInterface,
    private revisionRepository: RevisionRepositoryInterface,
  ) {}

  async execute(dto: CreateRevisionFromDumpDTO): Promise<Result<void>> {
    const filePathValidationResult = Validator.isNotEmptyString(dto.filePath)
    if (filePathValidationResult.isFailed()) {
      return Result.fail(`Could not create revision from dump: ${filePathValidationResult.getError()}`)
    }

    // The dump is removed whatever happens, including an exception (e.g. the database being busy).
    try {
      const revisionOrError = await this.dumpRepository.getRevisionFromDumpPath(dto.filePath)
      if (revisionOrError.isFailed()) {
        return Result.fail(`Could not create revision from dump: ${revisionOrError.getError()}`)
      }
      const revision = revisionOrError.getValue()

      const successfullyInserted = await this.revisionRepository.insert(revision)
      if (!successfullyInserted) {
        return Result.fail(`Could not insert revision from dump: ${revision.id.toString()}`)
      }

      return Result.ok()
    } finally {
      await this.dumpRepository.removeDump(dto.filePath)
    }
  }
}
