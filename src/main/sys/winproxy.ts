/**
 * Windows 系统代理的读取逻辑。
 *
 * 单独成文件是为了能被 CI 直接测试：`sysproxy.ts` 依赖 electron
 * （ipcMain / BrowserWindow / getAppConfig），在普通 Node 脚本里加载不了，
 * 而 Windows 分支又恰恰是最难在本机验证的一段。这里只依赖 child_process。
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

/** Windows 把系统代理存在 HKCU 下的这一处，不区分网络接口 */
export const WINDOWS_INTERNET_SETTINGS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

export interface WindowsSystemProxy {
  /** ProxyEnable 是否为 1 */
  enabled: boolean
  /** ProxyServer 的值，如 `127.0.0.1:7890`；未设置时为空串 */
  server: string
  /** ProxyOverride 的值（绕过列表），未设置时为空串 */
  bypass: string
}

/**
 * 读取当前 Windows 系统代理。
 *
 * `reg query` 在键或值不存在时会以非零码退出，所以这里逐个值单独读取，
 * 并把「读不到」当成空处理 —— 没设置过代理是正常状态，不是错误。
 */
export async function readWindowsSystemProxy(): Promise<WindowsSystemProxy> {
  const execFilePromise = promisify(execFile)

  const query = async (value: string): Promise<string> => {
    try {
      const { stdout } = await execFilePromise('reg', [
        'query',
        WINDOWS_INTERNET_SETTINGS_KEY,
        '/v',
        value
      ])
      return stdout
    } catch {
      return ''
    }
  }

  const enableOut = await query('ProxyEnable')
  // 输出形如：`    ProxyEnable    REG_DWORD    0x1`
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enableOut)

  const serverOut = await query('ProxyServer')
  const server = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+?)\s*$/m)?.[1]?.trim() ?? ''

  const bypassOut = await query('ProxyOverride')
  const bypass = bypassOut.match(/ProxyOverride\s+REG_SZ\s+(.+?)\s*$/m)?.[1]?.trim() ?? ''

  return { enabled, server, bypass }
}

/** 单个问题上发现的代理状态问题，与 sysproxy.ts 里的 SysProxyDriftIssue 同构 */
export interface WinDriftIssue {
  service: string
  kind: 'stale' | 'missing' | 'mismatch'
  detail: string
}

export interface WinDrift {
  supported: boolean
  ok: boolean
  expected: string | null
  enabledCount: number
  issues: WinDriftIssue[]
}

/**
 * Windows 的判定逻辑与读取分开，便于在没有 Windows 机器时用构造的输入做
 * 单元测试（CI 里的 test-sysproxy-windows 就是直接调它）。
 *
 * 选择让它独立于 electron 依赖放在本文件，而不是留在 sysproxy.ts：
 * 后者 import 了 ipcMain / BrowserWindow，普通 Node 脚本加载不了。
 */
export function evaluateWindowsDrift(
  actual: WindowsSystemProxy,
  expected: string | null,
  mode: string
): WinDrift {
  const issues: WinDriftIssue[] = []
  const { enabled, server } = actual

  if (enabled && !expected) {
    issues.push({ service: 'Windows', kind: 'stale', detail: `系统代理仍指向 ${server}` })
  } else if (!enabled && expected && mode === 'manual') {
    issues.push({
      service: 'Windows',
      kind: 'missing',
      detail: `系统代理未生效，期望 ${expected}`
    })
  } else if (enabled && expected && mode === 'manual' && server !== expected) {
    issues.push({
      service: 'Windows',
      kind: 'mismatch',
      detail: `系统代理指向 ${server}，期望 ${expected}`
    })
  }

  return {
    supported: true,
    ok: issues.length === 0,
    expected,
    enabledCount: enabled ? 1 : 0,
    issues
  }
}
