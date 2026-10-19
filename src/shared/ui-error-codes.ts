/**
 * UI 错误码中文展示映射（仅供界面文案，区别于 shared/tool-error-envelope 的分类/建议）。
 *
 * 未知 code 不白屏：显示原始 code + 通用说明。
 */

export const UI_ERROR_CODES: Readonly<Record<string, string>> = {
  // 授权/审批
  consumed: '授权凭证已被使用（一次性凭证不可重复消费）',
  'not-found': '资源或授权不存在',
  malformed: '授权凭证格式不正确',
  'bad-signature': '授权签名校验失败',
  expired: '授权已过期',
  'scope-mismatch': '授权范围与本次操作不匹配',
  'consent-unavailable': '当前无法征求同意（宿主未就绪），已按 fail-closed 拒绝',
  'consent-denied': '用户拒绝了本次操作',
  'policy-denied': '当前权限档位不允许该操作',
  denied: '操作被拒绝',
  // 连接/运行
  'page-disconnected': '页面连接已断开，本次执行被终止',
  'auth-failed': '鉴权失败，请重启应用',
  unauthorized: '缺少或无效的访问令牌',
  internal: '宿主内部错误，请查看日志',
  timeout: '操作超时',
  failed: '执行失败',
  cancelled: '已取消',
  // 工具参数/文件
  'missing-argument': '缺少必填参数',
  'invalid-argument': '参数格式不正确',
  'outside-workspace': '目标在工作区之外',
  'workspace-unconfigured': '尚未配置工作区',
  'io-error': '临时读写错误，可稍后重试',
  'limit-exceeded': '并发或数量超限，请等待当前任务结束',
  'call-error': '工具调用出错',
  'call-skip': '该工具调用被跳过',
};

/**
 * 返回错误码的中文展示文案；未知 code 显示原始 code + 通用说明，不抛错。
 */
export function describeErrorCode(code: string | null | undefined): string {
  if (!code) return '发生未知错误';
  const known = UI_ERROR_CODES[code];
  if (known) return known;
  return `错误码 ${code}：发生未归类错误，请查看宿主日志`;
}
