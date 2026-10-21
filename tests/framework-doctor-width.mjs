/**
 * 页面宽度调节的测试。
 *
 * 这是纯显示偏好，但有三个必须守住的性质：
 *   - 夹紧：滑块再怎么拖也不能把页面拖成 0 宽或 10000 宽
 *   - 坏数据不炸：localStorage 里是垃圾时回落默认值，不能让页面白屏
 *   - 记住：选过的宽度下次打开还在
 */
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = 'D:/loowaworkspeas/plugins/dsh-framework-doctor';

let failures = 0;
let checks = 0;

function ok(condition, label, detail) {
  checks += 1;
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 300)}`}`);
  }
}
function eq(a, b, label) {
  ok(Object.is(a, b), label, { actual: a, expected: b });
}

const source = readFileSync(`${ROOT}/client.js`, 'utf8');

console.log('\n=== 宽度常量与夹紧逻辑（源码层）===');
{
  // client.js 是浏览器模块，不能直接 import；用正则确认关键实现存在且自洽
  const minMatch = source.match(/var WIDTH_MIN = (\d+);/);
  const maxMatch = source.match(/var WIDTH_MAX = (\d+);/);
  const defMatch = source.match(/var WIDTH_DEFAULT = (\d+);/);

  ok(Boolean(minMatch), '定义了 WIDTH_MIN');
  ok(Boolean(maxMatch), '定义了 WIDTH_MAX');
  ok(Boolean(defMatch), '定义了 WIDTH_DEFAULT');

  const min = Number(minMatch?.[1]);
  const max = Number(maxMatch?.[1]);
  const def = Number(defMatch?.[1]);

  ok(min > 0, '最小值大于 0', min);
  ok(max > min, '最大值大于最小值', { min, max });
  ok(def >= min && def <= max, '默认值在范围内', { def, min, max });
  // 默认值要比原来的 960 宽，否则这次改动没意义
  ok(def > 960, '默认宽度比原来的 960 更宽', def);
  ok(max >= 2000, '最大值够大，能铺满大屏', max);
}

console.log('\n=== CSS 用变量驱动 ===');
{
  ok(
    /\.__fd_root\{[^}]*max-width:var\(--fd-max-width/.test(source),
    '根容器宽度用 CSS 变量',
  );
  ok(
    !/\.__fd_root\{[^}]*max-width:960px/.test(source),
    '不再硬编码 960px',
  );
  ok(source.includes("'--fd-max-width': widthPx + 'px'"), '渲染时把变量设成当前宽度');
  ok(/\.__fd_root\{[^}]*margin:0 auto/.test(source), '宽度小于容器时居中');
}

console.log('\n=== 辅助函数存在且安全 ===');
{
  ok(/function clampWidth\(/.test(source), '有 clampWidth');
  ok(/function readStoredWidth\(/.test(source), '有 readStoredWidth');
  ok(/function storeWidth\(/.test(source), '有 storeWidth');

  // 读的时候必须 try/catch（隐私模式下 localStorage 会抛）
  const readBody = source.slice(source.indexOf('function readStoredWidth'), source.indexOf('function storeWidth'));
  ok(/try\s*\{/.test(readBody), 'readStoredWidth 有 try');
  ok(/catch/.test(readBody), 'readStoredWidth 有 catch');
  ok(/Number\.isFinite/.test(source.slice(source.indexOf('function clampWidth'), source.indexOf('function readStoredWidth'))),
    'clampWidth 检查 NaN');

  const storeBody = source.slice(source.indexOf('function storeWidth'), source.indexOf('function Page'));
  ok(/try\s*\{/.test(storeBody), 'storeWidth 有 try');
  ok(/catch/.test(storeBody), 'storeWidth 有 catch');
}

console.log('\n=== 控件已挂上 ===');
{
  ok(source.includes("type: 'range'"), '有滑块');
  ok(source.includes('__fd_widthCtl'), '有容器类');
  ok(source.includes('onChange: function (event) { setWidthPx(clampWidth(event.target.value)); }'),
    '拖动时夹紧后写状态');
  ok(/widthReset/.test(source), '有重置按钮');
  ok(/useEffect\(function \(\) \{\s*storeWidth\(widthPx\);/.test(source), '宽度变化时写入存储');
}

console.log('\n=== 词典两种语言都齐 ===');
{
  for (const key of ['widthLabel', 'widthHint', 'widthReset']) {
    const count = (source.match(new RegExp(`${key}:`, 'g')) || []).length;
    eq(count, 2, `${key} 有中英两条`);
  }
  // 中文那条确实在
  ok(source.includes("widthLabel: '宽度'"), '中文 widthLabel 正确');
  ok(source.includes("widthLabel: 'Width'"), '英文 widthLabel 正确');
}

console.log('\n=== 键不重复 ===');
{
  // 检查中文词典块里没有混入英文值
  const zhStart = source.indexOf("title: '框架医生'");
  const zhBlock = zhStart >= 0 ? source.slice(zhStart, source.indexOf('};', zhStart)) : '';
  ok(zhBlock.length > 0, '找到中文词典块');
  ok(!zhBlock.includes("widthLabel: 'Width'"), '中文块里没有英文 widthLabel');
  ok(zhBlock.includes("widthLabel: '宽度'"), '中文块里有中文 widthLabel');
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败'}：${checks - failures}/${checks} 项通过`);
if (failures > 0) process.exitCode = 1;