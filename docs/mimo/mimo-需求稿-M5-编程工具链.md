# M5 编程工具链・mimo 需求稿

> 投喂对象：mimo
> 目标：设计 edit-engine /test-runner/debug 三个编程工具
> 前置：TaskLoop 已接管主路径，file.read/file.write 已有整写能力



***

## 一、背景

deepseek-studio 是浏览器形态 agent—— 把网页版 DeepSeek 拦出来当 LLM 后端。

现状：



* TaskLoop 是纯循环控制器，工具执行靠 engine 内部 interceptor

* file.read/file.write 已有整写能力

* shell.exec 已有，能跑命令

* 模型现在用 shell\_exec（curl /dir/find）读文件，笨且慢

M5 要做：让模型能用**编程工具链**改代码、跑测试、看错误。



***

## 二、要设计什么

### 2.1 edit-engine（改文件）

**问题**：file.write 是整文件写。模型改一行也要写整个文件，笨。

**要设计**：



* 局部改接口：oldString → newString

* 找不到 oldString 怎么办（报错？返回原文？）

* 多处匹配怎么办（报错？要 lineNumber？）

* 新增文件 vs 修改已有文件

* consent 闸对齐（write 档已经是高危，edit 呢）

### 2.2 test-runner（跑测试）

**问题**：模型要自己想 "跑什么命令"。应该有个 test 工具。

**要设计**：



* 接口：`test.run({ cmd?: string, scope?: string })`

* 默认跑什么（npm test？npx vitest run？）

* 输出怎么解析红绿（exit code？正则？）

* 失败怎么给模型（贴 stderr？摘错误行？）

* 超时多少

### 2.3 debug（错误恢复）

**问题**：工具失败了，模型不知道错在哪。

**要设计**：



* 工具失败时返回什么（stderr？错误码？堆栈？）

* 模型收到 error 后能不能自动重试

* 重试上限（防死循环）



***

## 三、约束



1. 纯函数包优先，不碰 kernel/ 主路径

2. 错误码复用 CONTRACTS §6.1 词表

3. 工作区外一律 fail-closed

4. 每个工具自带单测

5. 不绕 consent 闸



***

## 四、期望输出

mimo 出一份方案：



1. 三个工具的接口签名（入参 / 出参类型）

2. 每个工具的边界情况处理

3. 单测覆盖建议

4. 风险点



***

## 五、不要做什么



* 不要设计 edit-engine 替代 file.write（file.write 保留）

* 不要设计 IDE 集成（语法高亮、跳转定义）

* 不要设计 git 集成（commit /diff）