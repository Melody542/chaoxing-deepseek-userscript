# Chaoxing AI Dialogue + DeepSeek

一个本地运行的 Tampermonkey 油猴脚本，用于超星学习通 AI 实践对话页面：

- 读取当前智能体的最新问题。
- 通过 DeepSeek 网页接口生成回答。
- 将回答写回超星输入框并发送。
- 默认最多连续执行 10 轮。
- 支持暂停、恢复和“仅生成不发送”预演模式。
- 不会点击“AI结束练习并评估”。

## 安装

1. 确保浏览器已安装 Tampermonkey。
2. 打开 Tampermonkey 管理面板。
3. 新建脚本。
4. 用以下文件的内容替换编辑器中的默认内容：

   `dist/chaoxing-deepseek.user.js`

5. 保存脚本。
6. 确认脚本匹配以下两个域名：

   - `mooc2-ans.chaoxing.com`
   - `chat.deepseek.com`

## 使用

1. 手动登录超星并进入目标课程。
2. 手动点击“AI实践”任务并进入实际对话页。
3. 首次点击右下角面板的“开始”。
4. 脚本会打开一次 DeepSeek 页面：
   - 如果已经登录，脚本自动读取令牌并关闭该页。
   - 如果尚未登录，请手动完成登录，脚本会自动继续。
5. 返回超星页面后，脚本开始等待最新问题。
6. 随时点击“暂停”停止下一轮操作。

## 预演模式

面板中的“仅生成不发送”勾选框适合第一次验证选择器和 DeepSeek 接口：

- 勾选后运行一轮。
- 脚本仍会读取问题并请求 DeepSeek。
- 回答不会写入超星输入框，也不会点击发送。
- 控制台只显示前 20 个字符和回答长度。

确认一轮结果后取消勾选，再正式运行。

## 行为说明

- 首次授权后，运行期间不会持续打开 DeepSeek 页面。
- DeepSeek 令牌保存在 Tampermonkey 本地存储 `cx_ds_token_v1` 中。
- 脚本不保存超星或 DeepSeek 密码。
- 默认最多执行 10 轮。
- 暂停后再次点击“开始”会从当前轮次继续，并复用当前 DeepSeek 会话。
- 页面刷新后不会自动继续，需要重新点击“开始”。
- 达到 10 轮、页面不可作答、令牌失效或接口失败时停止。

## 本地开发

运行全部单元测试：

```powershell
node --test tests/*.test.cjs
```

运行官方 DeepSeekHashV1 在线向量测试：

```powershell
$env:DEEPSEEK_POW_LIVE='1'; node --test tests/pow-live.test.cjs
```

重新生成用户脚本：

```powershell
node scripts/build.cjs
```

构建输出：

`dist/chaoxing-deepseek.user.js`

## 常见问题

### 提示“登录令牌失效”

点击面板中的“重新授权”，重新登录 DeepSeek。脚本会重新读取本地令牌。

### 提示“PoW WASM 下载失败”

确认浏览器可以访问：

`https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm`

DeepSeek 更新静态资源后，需要同步更新脚本中的 WASM 地址。

### 找到输入框但找不到最新问题

超星页面结构可能已变化。先在面板勾选“仅生成不发送”测试，并检查 `src/chaoxing.cjs` 中的 `CALIBRATION`、消息候选过滤和左右位置判断。

### DeepSeek 返回空回答

脚本已经兼容命名 SSE 事件、无事件名数据帧、`response/fragments` 和 `response/status`。如果 DeepSeek 再次修改协议，脚本会暂停并报错，不会发送空回答。

## 限制

本脚本依赖 DeepSeek 网页版未公开接口、登录令牌和静态 WASM 资源。接口、风控算法、动态资源地址或超星页面 DOM 变化时，脚本可能需要更新。脚本不会绕过验证码、登录验证或其他站点安全措施。
