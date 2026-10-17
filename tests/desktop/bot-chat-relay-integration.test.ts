/**
 * v0.27a 验收测试：端到端集成（ContextEngine + AgentInstructionBuilder + 四类）
 *
 * 验收（答疑 Q7）：串起「人设指令注入（ContextEngine + AgentInstructionBuilder）+ 路由 + 接力」，
 * 比四类独立单测更能抓接线 bug。instructions.ts 只读消费，不改它。
 *
 * 注意：本测用临时 SQLite 文件；teardown 对 fs.rmSync 做容错（运行环境删除拦截器可能 EPERM）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore } from '../../src/host/memory-store';
import { SqliteChatMessageStore } from '../../src/host/bot/chat-room-store';
import { SqliteContextEngine } from '../../src/host/bot/context-engine';
import { createAgentInstructionBuilder } from '../../src/host/bot/instructions';
import { DefaultRoundOrchestrator, type GenerateReplyContext } from '../../src/host/bot/round-orchestrator';
import { DefaultMentionRouter } from '../../src/host/bot/mention-router';
import { DefaultHandoffParser } from '../../src/host/bot/handoff-parser';
import { MapParticipantResolver } from '../../src/host/bot/participant-resolver';
import { DefaultMentionParser } from '../../src/host/bot/mention-parser';
import type { Participant, RoomConfig, ChatMessage } from '../../src/host/bot/types';

const participants: Participant[] = [
  { name: 'frontend-expert', botId: 'bot-fe' },
  { name: 'backend-expert', botId: 'bot-be' },
];

const room: RoomConfig = {
  roomId: 'r1',
  roomName: '架构评审',
  memberPersonas: ['frontend-expert', 'backend-expert'],
};

/** personaInjector：把 AgentInstructionBuilder 的产出作为系统提示词片段注入。 */
const personaInjector = (ctx: {
  agentName: string;
  roomName: string;
  agentDescription: string;
  memberNames: readonly string[];
  summary: string;
}): string => createAgentInstructionBuilder().build(ctx).instructions;

let tmpDir: string;
let tmpDb: string;
let mem: MemoryStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-relay-'));
  tmpDb = path.join(tmpDir, 'memories.db');
  mem = new MemoryStore(tmpDb);
});

afterEach(() => {
  try {
    mem.getDb()?.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seedUser(content: string): ChatMessage {
  const store = new SqliteChatMessageStore(mem);
  return store.append({ roomId: 'r1', senderId: 'u1', senderType: 'user', content, timestamp: Date.now(), mentions: [] });
}

describe('聊天室指令与接力 · 端到端', () => {
  it('ContextEngine + AgentInstructionBuilder：人设指令注入到 systemPrompt', async () => {
    seedUser('讨论开始');
    const store = new SqliteChatMessageStore(mem);
    const engine = new SqliteContextEngine({ messageStore: store, memoryStore: mem });
    const lastId = store.getMessages('r1').at(-1)!.id;
    const ctx = await engine.buildContext({
      roomId: 'r1',
      agentName: 'frontend-expert',
      currentMessageId: lastId,
      personaInjector,
      roomName: '架构评审',
      agentDescription: '负责前端架构',
      memberNames: ['前端专家', '后端专家'],
    });
    expect(ctx.systemPrompt).toContain('你是「frontend-expert」');
    expect(ctx.systemPrompt).toContain('房间：架构评审');
    expect(ctx.messages.length).toBeGreaterThan(0);
  });

  it('四类串联：@前端专家 → 经 ContextEngine 取上下文并回复 @后端专家 → pendingHandoff 含 backend-expert', async () => {
    const seed = seedUser('架构怎么定');
    const store = new SqliteChatMessageStore(mem);
    const engine = new SqliteContextEngine({ messageStore: store, memoryStore: mem });

    const parser = new DefaultMentionParser();
    const resolver = new MapParticipantResolver(participants);
    const router = new DefaultMentionRouter(parser, resolver);
    const handoff = new DefaultHandoffParser(parser);

    // generateReply：用 ContextEngine 取该 persona 的上下文（验证 personaInjector 接线），然后返回含接力的回复。
    const builtSystemPrompts: string[] = [];
    const generateReply = async (_persona: string, _ctx: GenerateReplyContext): Promise<string> => {
      const c = await engine.buildContext({
        roomId: 'r1',
        agentName: _persona,
        currentMessageId: seed.id,
        personaInjector,
        roomName: room.roomName,
        agentDescription: '负责前端架构',
        memberNames: room.memberPersonas,
      });
      builtSystemPrompts.push(c.systemPrompt);
      return '@backend-expert 请补充后端视角';
    };

    const orch = new DefaultRoundOrchestrator({ router, handoffParser: handoff, participantResolver: resolver, generateReply });
    const round = await orch.planRound({ trigger: { ...seed, content: '@frontend-expert 架构怎么定' }, room, participants });

    expect(round.members).toEqual(['frontend-expert']);
    expect(round.pendingHandoff).toEqual(['backend-expert']);
    // 证明人设指令确实经 AgentInstructionBuilder 注入到了取上下文的环节。
    expect(builtSystemPrompts[0]).toContain('你是「frontend-expert」');
  });
});
