/** Minimal browser entry that retains the loader's config evaluator import. */
import { evaluate } from '../../../vendor/loader/src/config/utils.ts'

document.body.dataset.loaderLoaded = String(typeof evaluate === 'function')
