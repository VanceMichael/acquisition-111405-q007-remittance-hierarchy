# 结算回执的申报层次与调整资料采集

这是资料接收服务的独立工作副本。支持人工摘要（`legacy`）与合作方分层回执（`source`）两种来源：前者保留字段并做内容寻址归档；后者把付款、申报、服务行三层结构及各层调整完整落库，金额保留来源原文与按币种 scale 解释的整数精度，替换关系按 sender/control 追踪。全部资料为合成样本。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是初始产品的基线回归，验证现有摘要通路、原文摘要检查、本地来源响应，以及 CLI 在独立进程中的真实领取、重复导入和持久归档检查。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 中完整的新来源验收。此命令在初始版本会以非零状态退出，原因是新的 source 模式尚待开发，不是环境故障，也不属于已有产品基线。验收文件及断言原样保留，没有跳过、删除或把失败转为成功。交付时需执行 `npm run verify:complete`，让基线和新来源验收同时通过；不能只用基线成功说明新功能已完成。

```sh
npm run verify:complete
npm run demo:feature
```

正式演示使用完成后的 `npm run demo:feature`，从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `levels`。单次命令应在90秒内结束，不使用真实客户数据。

## 容器

```sh
docker build -t acquisition-remittance-hierarchy:local .
docker run --rm --network none acquisition-remittance-hierarchy:local
docker run --rm --network none acquisition-remittance-hierarchy:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令跑现有测试与实际摘要导入，不将未开发功能伪装成成功。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口；既有 `legacy` 模式要保留。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断。
- `src/archive.mjs` 支持内容寻址原文与记录修订，存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 对输出使用局部结构断言，不限制内部模块划分。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。

## 分层回执（source 模式）

`collect({baseUrl, archive, mode: 'source'})` 先领取 `/advice` 的信封列表，再按各信封的相对 `href` 逐条经 HTTP 取回正文。每条业务记录都带有 `paymentKey`、`claimKey`、`lineId` 与 SHA-256 原文证据，复核时无需再翻原文但原文始终可回溯。

- **三个层次各自保留调整**：服务行调整留在行上、申报调整留在申报上、`providerAdjustments` 只作用于整笔付款，绝不平均摊到申报或服务行。
- **金额原始精度**：顶层金额（如 `paid`、`charge`）保留来源十进制字符串；`minorUnits` 按币种 scale（CNY=2、JPY=0）解释为整数最小单位，仅用于复核计算。超过 scale 的精度、非字符串金额不四舍五入，标记 `pending` 并原样保留。
- **申报身份不靠控制号**：`claimKey = sender/claimId`、`paymentKey = sender/paymentId`；同一 `control` 在不同 sender 下是不同身份。归档 `id` 稳定且非空，但层次关系不压缩进 `id`。
- **差异定位而不补差**：`balances` 分别给出服务行、申报、付款三层的 residual 与 `balanceStatus`（`balanced`/`unbalanced`/`pending`）。对不上的金额保持来源原值，配套 `LINE_UNBALANCED`、`CLAIM_UNBALANCED`、`PAYMENT_UNBALANCED` 等带来源位置的 issue。
- **替换回执**：`replaces` 是 `{sender, control}` 而非 claimId。替换链按身份追踪、与领取顺序无关；缺失目标或成环时整条链保持 `pending`，链上回执不进入当前有效视图但证据仍归档。被替换回执标 `superseded`，链头最新回执才是 `active`。
- **无服务行付款**：输出付款级 `balanceStatus` 记录，申报层次保留在其 `claims` 中，不被付款合计吞掉。
- **未决即不完整**：任何缺口（越界链接、失败响应、坏 JSON、未声明币种、替换未决）都使 `complete=false` 并记入 `issues`；已安全接收的独立部分照常保留。空的有效信封列表属于完整结果。

边界回归见 `test/edge.test.mjs`（独立本地 HTTP 合成来源，不读取 `fixtures/scenarios.json`），覆盖整批费用不摊分、sender 作用域、替换成环与跨批次补全、精度冲突、越界链接、一汇多申报等。

