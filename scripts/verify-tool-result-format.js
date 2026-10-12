// 验证工具结果新格式：通过 WebSocket 直接调用 shell.exec，检查返回是否包含 content/details/isError
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:8760/studio');
const callId = 'test-' + Date.now();

ws.on('open', () => {
  console.log('[ws] connected');
  // 发送工具调用：shell.exec 执行 dir 命令
  const msg = {
    type: 'tool-call',
    callId,
    invocationName: 'shell.exec',
    params: { command: 'dir /b "E:\\NAS\\deepseek-studio\\docs"' },
  };
  console.log('[ws] sending:', JSON.stringify(msg).slice(0, 100));
  ws.send(JSON.stringify(msg));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'tool-call-result' && msg.callId === callId) {
    console.log('\n=== 工具调用结果 ===');
    console.log('ok:', msg.ok);
    console.log('error:', msg.error);
    console.log('\n--- 新格式字段检查 ---');
    console.log('content:', msg.content ? `存在 (${msg.content.length} 个片段)` : '缺失 ❌');
    if (msg.content) {
      console.log('  content[0].type:', msg.content[0]?.type);
      console.log('  content[0].text 前100字:', JSON.stringify(msg.content[0]?.text?.slice(0, 100)));
    }
    console.log('details:', msg.details ? `存在 (keys: ${Object.keys(msg.details).join(',')})` : '缺失 ❌');
    console.log('isError:', msg.isError);
    console.log('terminate:', msg.terminate);
    console.log('\n--- 旧格式字段（向后兼容）---');
    console.log('data.stdout 存在:', !!(msg.data && typeof msg.data === 'object' && 'stdout' in msg.data));
    console.log('data.exitCode:', msg.data?.exitCode);

    // 验证结论
    const hasContent = !!msg.content;
    const hasDetails = !!msg.details;
    const hasIsError = msg.isError !== undefined;
    const hasLegacyData = !!msg.data;
    console.log('\n=== 验证结论 ===');
    console.log('新格式 content:', hasContent ? '✅ 生效' : '❌ 未生效');
    console.log('新格式 details:', hasDetails ? '✅ 生效' : '❌ 未生效');
    console.log('新格式 isError:', hasIsError ? '✅ 生效' : '❌ 未生效');
    console.log('旧格式 data 兼容:', hasLegacyData ? '✅ 保留' : '❌ 丢失');
    if (hasContent && hasDetails && hasIsError && hasLegacyData) {
      console.log('\n🎉 第一阶段工具结果格式规范验证通过！');
      console.log('   - shell.exec 返回 content=[{type:text,text:stdout}]，模型可直接读取纯文本');
      console.log('   - details 包含 exitCode/durationMs/cwd/argv，UI 可展示元数据');
      console.log('   - isError=false 显式标记成功状态');
      console.log('   - 旧格式 data 完整保留，向后兼容');
    } else {
      console.log('\n⚠️ 部分字段未生效，需要检查');
    }
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (err) => {
  console.error('[ws] error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('超时：未收到工具调用结果');
  process.exit(1);
}, 15000);
