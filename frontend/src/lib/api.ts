export * from './api/net'

import { coreApi } from './api/core'
import { commentsApi } from './api/comments'
import { aiApi } from './api/ai'
import { accountApi } from './api/account'
import { collabApi } from './api/collab'
import { lifecycleApi } from './api/lifecycle'
import { publicShareApi } from './api/public_share'

export const api = {
  ...coreApi,
  ...commentsApi,
  ...aiApi,
  ...accountApi,
  ...collabApi,
  ...lifecycleApi,
  ...publicShareApi,
}
