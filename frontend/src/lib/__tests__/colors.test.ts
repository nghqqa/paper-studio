import { describe, expect, it } from 'vitest'
import { AVATAR_COLOR_HEX, avatarColorFor } from '@/types/account'
import { PEER_COLORS, PEER_COLOR_BY_NAME, colorFor, initialOf, labelText, userColor } from '../colors'

describe('userColor：全站头像色单源', () => {
  it('账户选了预设色 ⇒ 用它；未选 / 非法 ⇒ 按显示名哈希；无名 ⇒ 按邮箱', () => {
    const u = { display_name: '王五', email: 'w@x.com', avatar_color: 'teal' }
    expect(userColor(u)).toBe(PEER_COLOR_BY_NAME.teal)
    expect(userColor({ ...u, avatar_color: '' })).toBe(colorFor('王五'))
    expect(userColor({ ...u, avatar_color: 'not-a-color' })).toBe(colorFor('王五'))
    expect(userColor({ display_name: '  ', email: 'w@x.com' })).toBe(colorFor('w@x.com'))
    expect(userColor(null)).toBe(PEER_COLORS[0])
  })

  it('账户页派生色名 ↔ userColor 回退同一哈希（顶栏 / 成员表 / 账户页同色）', () => {
    for (const name of ['王五', 'Alice', ' 张三 ', 'z@x.com']) {
      expect(AVATAR_COLOR_HEX[avatarColorFor(name)]).toBe(userColor({ display_name: name, email: 'e@x' }))
    }
  })

  it('黄 / 青底用深字，其余白字', () => {
    expect(labelText(PEER_COLOR_BY_NAME.yellow)).toBe('#0b1220')
    expect(labelText(PEER_COLOR_BY_NAME.teal)).toBe('#0b1220')
    expect(labelText(PEER_COLOR_BY_NAME.blue)).toBe('#ffffff')
  })

  it('initialOf 取首字符并大写', () => {
    expect(initialOf('alice')).toBe('A')
    expect(initialOf(' 王五')).toBe('王')
    expect(initialOf('  ')).toBe('?')
  })
})
