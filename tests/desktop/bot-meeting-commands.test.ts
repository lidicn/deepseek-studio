/**
 * meeting-commands 单测（v0.29）
 *
 * 覆盖：显式命令优先级、@main 变体、自然语言两端匹配、句中关键词不误判、
 * cleanText 正确性、空输入与大小写不敏感。
 */
import { describe, expect, it } from 'vitest';
import { detectMeetingCommand, type MeetingCommand } from '../../src/host/bot/meeting-commands';

describe('detectMeetingCommand', () => {
  const kinds: Record<string, MeetingCommand['kind']> = {
    start: 'start',
    end: 'end',
    summarize: 'summarize',
    none: 'none',
  };

  it('识别显式斜杠开会命令并剥离出会议主题', () => {
    const cmd = detectMeetingCommand('/会议开始 讨论后端接口契约');
    expect(cmd.kind).toBe(kinds.start);
    expect(cmd.explicit).toBe(true);
    expect(cmd.cleanText).toBe('讨论后端接口契约');
  });

  it('识别 /开会 简写', () => {
    const cmd = detectMeetingCommand('/开会');
    expect(cmd.kind).toBe(kinds.start);
    expect(cmd.explicit).toBe(true);
    expect(cmd.cleanText).toBe('');
  });

  it('识别 @main 开始会议（大小写不敏感）', () => {
    const cmd = detectMeetingCommand('@Main 开始会议');
    expect(cmd.kind).toBe(kinds.start);
    expect(cmd.explicit).toBe(true);
  });

  it('识别 @main 开始 + 主题', () => {
    const cmd = detectMeetingCommand('@main 开始 聊聊支付重构');
    expect(cmd.kind).toBe(kinds.start);
    expect(cmd.cleanText).toBe('聊聊支付重构');
  });

  it('识别显式散会命令', () => {
    for (const text of ['/散会', '/会议结束', '@main 结束', '@main 散会']) {
      const cmd = detectMeetingCommand(text);
      expect(cmd, text).toMatchObject({ kind: kinds.end, explicit: true });
    }
  });

  it('识别显式总结命令', () => {
    for (const text of ['/总结', '@main 总结', '@main 现在总结', '@main 总结一下']) {
      const cmd = detectMeetingCommand(text);
      expect(cmd, text).toMatchObject({ kind: kinds.summarize, explicit: true });
    }
  });

  it('显式命令优先于自然语言关键词', () => {
    // 同时含 /散会（显式 end）——即使文本里也有 start 关键词也应以显式 end 为准
    const cmd = detectMeetingCommand('/散会 我们继续开始讨论');
    expect(cmd.kind).toBe(kinds.end);
    expect(cmd.explicit).toBe(true);
  });

  it('自然语言关键词在开头时触发开会', () => {
    for (const text of ['开始讨论后端接口契约', '开始会议', '我们来聊聊性能问题', '开会']) {
      const cmd = detectMeetingCommand(text);
      expect(cmd, text).toMatchObject({ kind: kinds.start, explicit: false });
    }
  });

  it('关键词开头的文本原样保留为 cleanText（真实讨论内容，需落盘）', () => {
    const cmd = detectMeetingCommand('开始讨论后端接口契约');
    expect(cmd.cleanText).toBe('开始讨论后端接口契约');
  });

  it('自然语言关键词在结尾时触发散会', () => {
    for (const text of ['现在散会', '今天就到这里', '总结并结束', '散会']) {
      const cmd = detectMeetingCommand(text);
      expect(cmd, text).toMatchObject({ kind: kinds.end, explicit: false });
    }
  });

  it('关键词出现在句中不触发（避免疑问句/引述误判）', () => {
    for (const text of [
      '这个会议结束了吗？',
      '你提到散会是什么意思',
      '我们下周再开会吧，先把需求列一下',
      '讨论一下散会前的收尾事项',
    ]) {
      const cmd = detectMeetingCommand(text);
      expect(cmd, text).toMatchObject({ kind: kinds.none });
    }
  });

  it('普通讨论消息返回 none 且 cleanText 为原文', () => {
    const text = '@backend-expert 接口契约的分页语义怎么定？';
    const cmd = detectMeetingCommand(text);
    expect(cmd).toEqual({ kind: kinds.none, explicit: false, cleanText: text });
  });

  it('空输入与纯空白返回 none', () => {
    for (const text of ['', '   ', '\t\n ']) {
      expect(detectMeetingCommand(text)).toEqual({ kind: kinds.none, explicit: false, cleanText: '' });
    }
  });

  it('不依赖 mention-parser：@main 即使不在 memberPersonas 也能被识别', () => {
    // 本函数不接收 participants 参数 —— 纯文本判定
    const cmd = detectMeetingCommand('@main 现在总结');
    expect(cmd.kind).toBe(kinds.summarize);
    expect(cmd.explicit).toBe(true);
  });

  it('全角空格分隔的显式命令也能匹配', () => {
    const cmd = detectMeetingCommand('/散会  后续再说');
    expect(cmd.kind).toBe(kinds.end);
  });
});
