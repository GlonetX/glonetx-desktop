import { getAppConfig, getControledMihomoConfig, patchAppConfig } from '../config'
import { pacPort, startPacServer, stopPacServer } from '../resolve/server'
import { promisify } from 'util'
import { execFile, execFileSync } from 'child_process'
import { servicePath } from '../utils/dirs'
import { net } from 'electron'
import {
  disableProxy,
  setPac,
  setProxy,
  setSysDns,
  startServiceSysproxyEventStream,
  stopServiceSysproxyEventStream,
  subscribeServiceSysproxyEvents
} from '../service/api'
import type { ServiceSysproxyEvent } from '../service/api'
import { appendAppLog } from '../utils/log'
import { showNotification } from '../utils/notification'

let defaultBypass: string[]
let triggerSysProxyTimer: NodeJS.Timeout | null = null
let triggerSysProxyTask = Promise.resolve()
let triggerSysProxyRequest = 0
let sysproxyGuardEventsStartedAt = 0
let lastSysproxyGuardNotificationKey = ''
let unsubscribeSysproxyGuardEvents: (() => void) | null = null

function registryArgs(useRegistry: boolean): string[] {
  return process.platform === 'win32' && useRegistry ? ['--use-registry'] : []
}

function activeDeviceArgs(onlyActiveDevice: boolean): string[] {
  return onlyActiveDevice ? ['--only-active-device'] : []
}

export function triggerSysProxy(
  enable: boolean,
  onlyActiveDevice: boolean,
  useRegistry = false
): Promise<void> {
  const request = ++triggerSysProxyRequest
  if (triggerSysProxyTimer) {
    clearTimeout(triggerSysProxyTimer)
    triggerSysProxyTimer = null
  }
  const task = triggerSysProxyTask.then(() => {
    // 已被更新请求取代的操作直接跳过，避免连续点击时排队累加耗时
    if (request !== triggerSysProxyRequest) return
    return triggerSysProxyImpl(enable, onlyActiveDevice, useRegistry, request)
  })
  triggerSysProxyTask = task.catch(() => {})
  return task
}

async function triggerSysProxyImpl(
  enable: boolean,
  onlyActiveDevice: boolean,
  useRegistry: boolean,
  request: number
): Promise<void> {
  if (enable) {
    if (net.isOnline()) {
      await setSysProxy(onlyActiveDevice, useRegistry)
    } else {
      if (request !== triggerSysProxyRequest) return
      triggerSysProxyTimer = setTimeout(() => {
        triggerSysProxy(enable, onlyActiveDevice, useRegistry).catch((error) => {
          appendAppLog(`[Sysproxy]: retry enable failed, ${error}\n`).catch(() => {})
        })
      }, 5000)
    }
  } else {
    await disableSysProxy(onlyActiveDevice, useRegistry)
  }
}

async function setSysProxy(onlyActiveDevice: boolean, useRegistry = false): Promise<void> {
  if (process.platform === 'linux')
    defaultBypass = [
      'localhost',
      '.local',
      '127.0.0.1/8',
      '192.168.0.0/16',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '::1'
    ]
  if (process.platform === 'darwin')
    defaultBypass = [
      '127.0.0.1/8',
      '192.168.0.0/16',
      '10.0.0.0/8',
      '172.16.0.0/12',
      'localhost',
      '*.local',
      '*.crashlytics.com',
      '<local>'
    ]
  if (process.platform === 'win32')
    defaultBypass = [
      'localhost',
      '127.*',
      '192.168.*',
      '10.*',
      '172.16.*',
      '172.17.*',
      '172.18.*',
      '172.19.*',
      '172.20.*',
      '172.21.*',
      '172.22.*',
      '172.23.*',
      '172.24.*',
      '172.25.*',
      '172.26.*',
      '172.27.*',
      '172.28.*',
      '172.29.*',
      '172.30.*',
      '172.31.*',
      '<local>'
    ]
  await startPacServer()
  const { sysProxy } = await getAppConfig()
  const { mode, host, bypass = defaultBypass, settingMode = 'exec' } = sysProxy
  const guard = settingMode === 'service' && !!sysProxy.guard
  const guardNotify = guard && !!sysProxy.guardNotify
  const { 'mixed-port': port = 7890 } = await getControledMihomoConfig()
  const execFilePromise = promisify(execFile)

  switch (mode || 'manual') {
    case 'auto': {
      if (settingMode === 'service') {
        try {
          await setPac(
            `http://${host || '127.0.0.1'}:${pacPort}/pac`,
            '',
            onlyActiveDevice,
            useRegistry,
            guard
          )
          updateSysproxyGuardEventStream(guardNotify)
        } catch {
          throw new Error('服务可能未安装')
        }
      } else {
        updateSysproxyGuardEventStream(false)
        await execFilePromise(servicePath(), [
          'sysproxy',
          'pac',
          '--url',
          `http://${host || '127.0.0.1'}:${pacPort}/pac`,
          ...activeDeviceArgs(onlyActiveDevice),
          ...registryArgs(useRegistry)
        ])
      }
      break
    }

    case 'manual': {
      if (port != 0) {
        if (settingMode === 'service') {
          try {
            await setProxy(
              `${host || '127.0.0.1'}:${port}`,
              bypass.join(','),
              '',
              onlyActiveDevice,
              useRegistry,
              guard
            )
            updateSysproxyGuardEventStream(guardNotify)
          } catch {
            throw new Error('服务可能未安装')
          }
        } else {
          updateSysproxyGuardEventStream(false)
          await execFilePromise(servicePath(), [
            'sysproxy',
            'proxy',
            '--server',
            `${host || '127.0.0.1'}:${port}`,
            '--bypass',
            process.platform === 'win32' ? bypass.join(';') : bypass.join(','),
            ...activeDeviceArgs(onlyActiveDevice),
            ...registryArgs(useRegistry)
          ])
        }
      } else {
        updateSysproxyGuardEventStream(false)
      }
      break
    }
  }
}

async function disableSysProxy(onlyActiveDevice: boolean, useRegistry = false): Promise<void> {
  await stopPacServer()
  updateSysproxyGuardEventStream(false)
  const { sysProxy } = await getAppConfig()
  const { settingMode = 'exec' } = sysProxy
  const execFilePromise = promisify(execFile)
  const disableWithExec = (): Promise<unknown> =>
    execFilePromise(servicePath(), [
      'sysproxy',
      'disable',
      ...activeDeviceArgs(onlyActiveDevice),
      ...registryArgs(useRegistry)
    ])

  if (settingMode === 'service') {
    try {
      await disableProxy('', onlyActiveDevice, useRegistry)
    } catch (e) {
      await appendAppLog(`[Sysproxy]: disable via service failed, fallback to exec, ${e}\n`)
      await disableWithExec()
    }
  } else {
    await disableWithExec()
  }
}

function updateSysproxyGuardEventStream(enabled: boolean): void {
  if (enabled) {
    sysproxyGuardEventsStartedAt = Date.now()
    if (!unsubscribeSysproxyGuardEvents) {
      unsubscribeSysproxyGuardEvents = subscribeServiceSysproxyEvents(handleSysproxyGuardEvent)
    }
    startServiceSysproxyEventStream().catch((error) => {
      appendAppLog(`[Service]: start sysproxy event stream failed, ${error}\n`).catch(() => {})
    })
  } else {
    if (unsubscribeSysproxyGuardEvents) {
      unsubscribeSysproxyGuardEvents()
      unsubscribeSysproxyGuardEvents = null
    }
    stopServiceSysproxyEventStream()
    lastSysproxyGuardNotificationKey = ''
  }
}

async function handleSysproxyGuardEvent(event: ServiceSysproxyEvent): Promise<void> {
  if (!(await shouldNotifySysproxyGuardEvent(event))) return

  if (event.type === 'guard_restored') {
    void showNotification({ title: '系统代理已恢复', variant: 'success' })
    return
  }

  void showNotification({
    title: '系统代理恢复失败',
    body: event.error || event.message,
    variant: 'danger'
  })
}

async function shouldNotifySysproxyGuardEvent(event: ServiceSysproxyEvent): Promise<boolean> {
  if (event.type !== 'guard_restored' && event.type !== 'guard_restore_failed') return false

  const eventTime = Date.parse(event.time)
  if (Number.isFinite(eventTime) && eventTime < sysproxyGuardEventsStartedAt) return false

  const { sysProxy } = await getAppConfig()
  if (!sysProxy.guardNotify) return false

  const key = `${event.type}:${event.seq ?? ''}:${event.time}`
  if (key === lastSysproxyGuardNotificationKey) return false
  lastSysproxyGuardNotificationKey = key
  return true
}

export function disableSysProxySync(useRegistry = false): void {
  if (process.platform !== 'win32') return

  try {
    execFileSync(servicePath(), ['sysproxy', 'disable', ...registryArgs(useRegistry)], {
      stdio: 'ignore',
      timeout: 3000
    })
  } catch {
    // ignore
  }
}

export interface ForceRestoreResult {
  /** 已清除代理的网络服务数量 */
  cleared: number
  /** DNS 是否被还原 */
  dnsRestored: boolean
  /** 未能处理的项，逐条说明 */
  errors: string[]
}

/**
 * 强制把本机网络配置恢复到未被本应用改动的状态。
 *
 * 这个入口存在的场景：应用异常退出 / 被强杀 / 崩溃，系统代理已经指向
 * 127.0.0.1:7890，但代理进程已经没了 —— 此时整台机器断网，而正常的
 * 开关路径依赖 core 与 service 能正常响应，用不了。
 *
 * 因此这里刻意不走 `triggerSysProxy`：不检查 `net.isOnline()`（断网正是
 * 要修的问题）、不看 `sysProxy.enable`、不受 `onlyActiveDevice` 限制，
 * 对所有网络服务逐个清除。
 *
 * 只能保证"不再有任何指向本应用的代理"，无法还原成"某个第三方代理配置"，
 * 因为应用从未记录过系统代理的原始值（只有 DNS 记录过，见 originDNS）。
 */
export async function forceRestoreNetwork(): Promise<ForceRestoreResult> {
  const errors: string[] = []
  let cleared: number

  // 1. 停掉 PAC 服务与守护，避免刚清完又被写回去
  await stopPacServer().catch((error) => {
    errors.push(`停止 PAC 服务失败：${error}`)
  })
  updateSysproxyGuardEventStream(false)

  // 2. 清除系统代理。先走 service / 内置二进制，再按平台兜底
  try {
    // onlyActiveDevice 固定为 false：强制恢复要覆盖所有接口，
    // 包括当时未启用、但之后会被系统启用的那些
    await disableSysProxy(false, process.platform === 'win32')
  } catch (error) {
    errors.push(`清除系统代理失败：${error}`)
  }

  // 3. 平台兜底。service 二进制缺失时上面的步骤会失败，
  //    用系统自带命令再清一遍，保证用户至少能上网
  if (process.platform === 'darwin') {
    const native = await clearDarwinProxy()
    cleared = native.cleared
    errors.push(...native.errors)
  } else if (process.platform === 'win32') {
    cleared = errors.length === 0 ? 1 : 0
  } else {
    cleared = errors.length === 0 ? 1 : 0
  }

  // 4. 还原 DNS（只有 darwin 记录过原始值）
  let dnsRestored = false
  if (process.platform === 'darwin') {
    try {
      dnsRestored = await restoreOriginDNS()
    } catch (error) {
      errors.push(`还原 DNS 失败：${error}`)
    }
  }

  // 5. 让开关与真实状态一致，否则 UI 仍显示"已开启"
  try {
    await patchAppConfig({ sysProxy: { enable: false } })
  } catch (error) {
    errors.push(`保存配置失败：${error}`)
  }

  await appendAppLog(
    `[Sysproxy]: force restore network finished, cleared=${cleared}, dnsRestored=${dnsRestored}` +
      (errors.length ? `, errors=${errors.join(' | ')}` : '') +
      '\n'
  )

  return { cleared, dnsRestored, errors }
}

/**
 * 还原被本应用改动的 DNS。
 *
 * 与 `core/network.ts` 的 `recoverDNS()` 等价，但刻意在这里重新实现：
 * `network.ts` 已经 import 了本模块，反向引用会形成循环依赖。
 *
 * `originDNS` 记的是首次设置公共 DNS 前的值；保存的是字符串 `'Empty'`
 * 时表示原本就没有自定义 DNS，`networksetup -setdnsservers <svc> empty`
 * 正是官方清除方式（见 `man networksetup`）。
 */
async function restoreOriginDNS(): Promise<boolean> {
  const { originDNS, autoSetDNSMode = 'none' } = await getAppConfig()
  if (!originDNS) return false

  const execFilePromise = promisify(execFile)
  const { stdout: deviceOut } = await execFilePromise('route', ['-n', 'get', 'default'])
  const device = deviceOut
    .split('\n')
    .find((s) => s.includes('interface:'))
    ?.trim()
    .split(' ')
    .slice(1)
    .join(' ')
  if (!device) throw new Error('无法确定默认网络接口')

  const { stdout: order } = await execFilePromise('networksetup', ['-listnetworkserviceorder'])
  const block = order.split('\n\n').find((s) => s.includes(`Device: ${device}`))
  if (!block) throw new Error(`无法定位 ${device} 对应的网络服务`)

  const serviceLine = block.split('\n').find((line) => /^\(\d+\).*/.test(line))
  if (!serviceLine) throw new Error(`无法解析 ${device} 的网络服务名`)
  const service = serviceLine.trim().split(' ').slice(1).join(' ')

  const servers = originDNS.split(' ').filter((s) => s.length > 0)
  if (servers.length === 0) return false

  if (autoSetDNSMode === 'service') {
    await setSysDns(service, servers)
  } else {
    await execFilePromise('networksetup', ['-setdnsservers', service, ...servers])
  }

  await patchAppConfig({ originDNS: undefined })
  return true
}

/**
 * macOS 兜底实现：直接对所有网络服务关掉 Web / Secure Web / SOCKS /
 * PAC / 自动发现。不依赖 sparkle-service，所以在二进制缺失或服务未安装
 * 时仍然有效。
 */
async function clearDarwinProxy(): Promise<{ cleared: number; errors: string[] }> {
  const execFilePromise = promisify(execFile)
  const errors: string[] = []
  let cleared = 0

  let services: string[]
  try {
    const { stdout } = await execFilePromise('networksetup', ['-listallnetworkservices'])
    services = stdout
      .split('\n')
      .slice(1) // 首行是说明文字
      .map((line) => line.replace(/^\*/, '').trim()) // 前导 * 表示该服务被停用
      .filter((line) => line.length > 0)
  } catch (error) {
    errors.push(`读取网络服务列表失败：${error}`)
    return { cleared, errors }
  }

  for (const service of services) {
    try {
      // 每一项单独执行：某个服务不允许修改时，不影响其它服务
      for (const args of [
        ['-setwebproxystate', service, 'off'],
        ['-setsecurewebproxystate', service, 'off'],
        ['-setsocksfirewallproxystate', service, 'off'],
        ['-setproxyautodiscovery', service, 'off'],
        ['-setautoproxystate', service, 'off']
      ]) {
        await execFilePromise('networksetup', args)
      }
      cleared++
    } catch (error) {
      errors.push(`清除 ${service} 的代理设置失败：${error}`)
    }
  }

  return { cleared, errors }
}
