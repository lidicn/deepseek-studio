/**
 * v0.26 验收测试：MentionParser（@解析纯算法）
 *
 * 验收标准（路线图 §2.7 + 回复单）：
 * - resolveMentions("@前端专家", [{name:'前端专家'}]) → [{type:'agent',participantId:'前端专家'}]
 * - resolveMentions("@all 大家说说") → [{type:'all'}]
 * - 邮箱 admin@x.com 不误命中
 * - CJK/emoji 边界正确；<quoted_message> 引用块内 @ 不解析
 * - stripMentionTokens 返回净内容
 */
import { describe, it, expect } from 'vitest';
import { DefaultMentionParser } from '../../src/host/bot/mention-parser';

const parser = new DefaultMentionParser();
const participants = [
  { name: '前端专家' },
  { name: '后端专家' },
  { name: 'audit-expert' },
];

describe('resolveMentions - 具体人设名', () => {
  it('@前端专家 解析为 agent 且 participantId 为 persona 名', () => {
    expect(parser.resolveMentions('@前端专家', participants)).toEqual([
      { type: 'agent', participantId: '前端专家' },
    ]);
  });

  it('带后续内容也能命中', () => {
    expect(parser.resolveMentions('@前端专家 你怎么看', participants)).toEqual([
      { type: 'agent', participantId: '前端专家' },
    ]);
  });

  it('未 @ 任何人返回空数组', () => {
    expect(parser.resolveMentions('大家好', participants)).toEqual([]);
  });

  it('英文 persona 名大小写不敏感命中', () => {
    expect(parser.resolveMentions('@Audit-Expert 请审查', participants)).toEqual([
      { type: 'agent', participantId: 'audit-expert' },
    ]);
  });

  it('多个 @ 分别解析', () => {
    expect(parser.resolveMentions('@前端专家 @后端专家 讨论', participants)).toEqual([
      { type: 'agent', participantId: '前端专家' },
      { type: 'agent', participantId: '后端专家' },
    ]);
  });
});

describe('resolveMentions - @all', () => {
  it('@all 解析为 all 类型', () => {
    expect(parser.resolveMentions('@all 大家说说', participants)).toEqual([{ type: 'all' }]);
  });

  it('isAllMentioned 正确', () => {
    expect(parser.isAllMentioned('@all 集合')).toBe(true);
    expect(parser.isAllMentioned('@前端专家 你来')).toBe(false);
    expect(parser.isAllMentioned('没有提及')).toBe(false);
  });

  it('@ALL 大小写不敏感', () => {
    expect(parser.resolveMentions('@ALL', participants)).toEqual([{ type: 'all' }]);
  });
});

describe('边界判断', () => {
  it('邮箱 admin@x.com 不误命中', () => {
    expect(parser.resolveMentions('联系 admin@x.com 即可', participants)).toEqual([]);
  });

  it('标识符后缀不误命中（@前端专家abc 不算）', () => {
    // '前端专家' 后跟 'a'（连续字符）→ 非边界，不匹配
    expect(parser.resolveMentions('@前端专家abc', participants)).toEqual([]);
  });

  it('emoji 后边界（@前端专家😀）仍命中', () => {
    expect(parser.resolveMentions('@前端专家😀 你好', participants)).toEqual([
      { type: 'agent', participantId: '前端专家' },
    ]);
  });

  it('最长匹配：@前端专家 不重复命中子串 前端', () => {
    const ps = [{ name: '前端' }, { name: '前端专家' }];
    expect(parser.resolveMentions('@前端专家 你好', ps)).toEqual([
      { type: 'agent', participantId: '前端专家' },
    ]);
  });
});

describe('引用块屏蔽', () => {
  it('<quoted_message> 块内 @ 不解析', () => {
    const content =
      '<quoted_message>@前端专家 别理这个</quoted_message> 真的@前端专家 来';
    expect(parser.resolveMentions(content, participants)).toEqual([
      { type: 'agent', participantId: '前端专家' },
    ]);
  });
});

describe('stripMentionTokens', () => {
  it('剥离 @名 与紧跟空格，返回净内容', () => {
    expect(parser.stripMentionTokens('@前端专家 你怎么看', participants)).toBe('你怎么看');
  });

  it('@all 也能剥离', () => {
    expect(parser.stripMentionTokens('@all 大家说说', participants)).toBe('大家说说');
  });

  it('无 @ 时原样返回', () => {
    expect(parser.stripMentionTokens('普通内容', participants)).toBe('普通内容');
  });

  it('CJK 后续无空格只剥 @名', () => {
    expect(parser.stripMentionTokens('@前端专家你怎么看', participants)).toBe('你怎么看');
  });
});
