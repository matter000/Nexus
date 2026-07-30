/**
 * SSRF 防护工具
 * 检测 URL 是否指向内网/私有地址，供 fetch_url 工具与工具注册中心统一复用，
 * 避免各处实现不一致导致防护范围出现缺口。
 */

/**
 * 检查 URL 是否指向内网/私有地址（SSRF 防护）。
 * 覆盖：localhost/loopback、云元数据端点（AWS/GCP）、IPv4 私有范围、.local/.internal 后缀。
 * @returns true 表示是私有地址（应拒绝），false 表示公网地址
 */
export function isPrivateUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr)
    const hostname = parsed.hostname.toLowerCase()

    // localhost / 短主机名
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    ) {
      return true
    }

    // 云元数据端点
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      return true
    }

    // IPv4 私有范围
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (ipv4Match) {
      const [_, a, b] = ipv4Match.map(Number) as unknown as [string, number, number, number, number]
      // 10.0.0.0/8
      if (a === 10) return true
      // 172.16.0.0/12
      if (a === 172 && b >= 16 && b <= 31) return true
      // 192.168.0.0/16
      if (a === 192 && b === 168) return true
      // 127.0.0.0/8 (loopback)
      if (a === 127) return true
      // 169.254.0.0/16 (link-local)
      if (a === 169 && b === 254) return true
      // 0.0.0.0/8
      if (a === 0) return true
    }

    // .local / .internal 后缀
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return true
    }

    return false
  } catch {
    return true // URL 解析失败，保守拒绝
  }
}
