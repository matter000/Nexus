/**
 * 单元测试: SSRF 防护（isPrivateUrl）
 * 覆盖私有地址拒绝、公网地址放行、边界网段与异常输入。
 */

import { describe, expect, it } from 'bun:test'
import { isPrivateUrl } from '../../src/utils/ssrf'

describe('SSRF 防护 isPrivateUrl', () => {
  describe('应拒绝内网/私有地址', () => {
    it('localhost 与回环地址', () => {
      expect(isPrivateUrl('http://localhost/x')).toBe(true)
      expect(isPrivateUrl('http://127.0.0.1/x')).toBe(true)
      expect(isPrivateUrl('http://127.5.5.5/x')).toBe(true) // 127.0.0.0/8 全网段
      expect(isPrivateUrl('http://[::1]/x')).toBe(true)
    })

    it('10.0.0.0/8 私有范围', () => {
      expect(isPrivateUrl('http://10.0.0.1/x')).toBe(true)
      expect(isPrivateUrl('https://10.255.255.255/x')).toBe(true)
    })

    it('172.16.0.0/12 私有范围', () => {
      expect(isPrivateUrl('http://172.16.0.1/x')).toBe(true)
      expect(isPrivateUrl('http://172.31.255.255/x')).toBe(true)
    })

    it('192.168.0.0/16 私有范围', () => {
      expect(isPrivateUrl('http://192.168.1.1/x')).toBe(true)
      expect(isPrivateUrl('http://192.168.0.1:8080/admin')).toBe(true)
    })

    it('0.0.0.0/8 与 link-local', () => {
      expect(isPrivateUrl('http://0.0.0.0/x')).toBe(true)
      expect(isPrivateUrl('http://169.254.1.1/x')).toBe(true)
    })

    it('云元数据端点（AWS / GCP）', () => {
      expect(isPrivateUrl('http://169.254.169.254/latest/meta-data/')).toBe(true)
      expect(isPrivateUrl('http://metadata.google.internal/x')).toBe(true)
    })

    it('.local / .internal 后缀', () => {
      expect(isPrivateUrl('http://db.local/x')).toBe(true)
      expect(isPrivateUrl('http://service.internal/x')).toBe(true)
    })
  })

  describe('应放行公网地址', () => {
    it('常见公网 IP 与域名', () => {
      expect(isPrivateUrl('https://8.8.8.8/x')).toBe(false)
      expect(isPrivateUrl('https://1.1.1.1/x')).toBe(false)
      expect(isPrivateUrl('https://example.com/page')).toBe(false)
    })

    it('私有范围边界外的相邻网段', () => {
      expect(isPrivateUrl('http://172.15.0.1/x')).toBe(false) // 172.16 之前
      expect(isPrivateUrl('http://172.32.0.1/x')).toBe(false) // 172.31 之后
      expect(isPrivateUrl('http://192.167.1.1/x')).toBe(false) // 非 192.168
      expect(isPrivateUrl('http://9.0.0.1/x')).toBe(false) // 非 10 段
    })
  })

  describe('异常输入保守拒绝', () => {
    it('无效 URL 解析失败时拒绝', () => {
      expect(isPrivateUrl('not a url')).toBe(true)
      expect(isPrivateUrl('')).toBe(true)
    })
  })
})
