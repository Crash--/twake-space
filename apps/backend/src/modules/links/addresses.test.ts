import { describe, expect, it } from 'vitest'
import { isPublicAddress } from './addresses.ts'

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fec0::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:a00:1',
    '::7f00:1',
    '64:ff9b::a00:1',
    'not an address'
  ])('refuses %s', address => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each(['93.184.215.14', '::ffff:93.184.215.14', '2606:4700::6810:84e5'])(
    'takes %s',
    address => {
      expect(isPublicAddress(address)).toBe(true)
    }
  )
})
