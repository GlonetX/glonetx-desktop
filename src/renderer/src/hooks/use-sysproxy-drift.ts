import useSWR from 'swr'
import { detectSysProxyDrift } from '@renderer/utils/ipc'

/**
 * 系统代理的「配置期望」与「系统真实状态」是否一致。
 *
 * 两者会漂移：应用被强杀、被别的软件改掉、或开机时网络服务重新启用，
 * 都可能让系统上留着一个已经失效的 127.0.0.1:7890，从而整机断网，
 * 而界面上的开关仍然是「已开启」。这个 hook 负责把差异读出来供界面提示。
 *
 * 检测依赖系统命令（macOS 上每个网络服务一次 networksetup），因此：
 * - 默认 30 秒轮询一次：漂移没有事件通知，只能轮询
 * - 失败时保留上一次结果，避免网络抖动导致提示闪烁
 */
export function useSysProxyDrift(): {
  drift: SysProxyDrift | undefined
  refresh: () => void
} {
  const { data, mutate } = useSWR(
    'detectSysProxyDrift',
    async (): Promise<SysProxyDrift> => {
      try {
        return await detectSysProxyDrift()
      } catch {
        // 平台缺少系统命令时不应打扰用户，按「一致」处理
        return { supported: false, ok: true, expected: null, enabledCount: 0, issues: [] }
      }
    },
    {
      refreshInterval: 30000,
      revalidateOnFocus: true,
      keepPreviousData: true,
      shouldRetryOnError: false
    }
  )

  return { drift: data, refresh: mutate }
}
