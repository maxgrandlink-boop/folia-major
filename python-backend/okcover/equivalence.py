import os

# 分析 v4 §8：等价口径是工作台打完补丁之后的行为。
# D11 的实机逐字节比对留到 J1，机器是 D:\okchang-test，上面有两首 flac。
# v4 §8.3 另说和 1.0.7 的录音不能要求逐位一致（GPU 非确定）。那是另一项比对。

D11_STATUS = 'deferred-to-j1'
D11_MACHINE = 'D:\\okchang-test'

# choice：
#   workbench  按补丁后的行为做
#   design-4.4 和补丁冲突时先按设计稿，留给架构师
#   out-of-scope 不是这个入口的职责，单测只锁住「我们不做」
POINTS = (
    {'id': 1, 'warning': False, 'choice': 'design-4.4',
     'behavior': '入口直接调 ProcessPipeline，不拉起 api_wrapper.py'},
    {'id': 2, 'warning': True, 'choice': 'design-4.4',
     'behavior': '写 jobDir/okc_backend_config.json，不写 tmp_api_config.json，跑完不删'},
    {'id': 3, 'warning': True, 'choice': 'workbench',
     'behavior': '清掉补丁列出的环境变量并设置 UTF-8 等；不把 PATH 收成封闭列表'},
    {'id': 4, 'warning': False, 'choice': 'design-4.4',
     'behavior': '缺组件文件由 --selftest 回 COMPONENT_MISSING，任务进程不再找 workenv/python.exe'},
    {'id': 5, 'warning': False, 'choice': 'workbench',
     'behavior': '翻译真实键；index_rate 的本地换算是 formant_slider/100，云端是 formant_shift'},
    {'id': 6, 'warning': False, 'choice': 'design-4.4',
     'behavior': 'stdout 只有 JSON 行，没有 API_RESULT_START/END'},
    {'id': 7, 'warning': True, 'choice': 'design-4.4',
     'behavior': '进度是阶段 pct，不是工作台的 2/10/40/70/100'},
    {'id': 8, 'warning': True, 'choice': 'workbench',
     'behavior': 'svc_outputs 非空且每一项都成功才算成功'},
    {'id': 9, 'warning': False, 'choice': 'design-4.4',
     'behavior': '取消写 CANCELLED 并以 130 退出，不是终止后不发信号'},
    {'id': 10, 'warning': False, 'choice': 'design-4.4',
     'behavior': 'msst_method 传 library/normal；aggressive 拒绝；不改 PB 预设'},
    {'id': 11, 'warning': False, 'choice': 'design-4.4',
     'behavior': '和声放进 dropped.reverb，不入库'},
    {'id': 12, 'warning': True, 'choice': 'workbench',
     'behavior': 'f0 只有 pm/harvest/crepe/rmvpe；不写 f0_min/f0_max；index_rate 两个来源分开换算'},
    {'id': 13, 'warning': False, 'choice': 'design-4.4',
     'behavior': '作品文件名不带括号；PB 中间产物仍是 (人声) 那套'},
    {'id': 14, 'warning': False, 'choice': 'design-4.4',
     'behavior': '认轨用伴奏/原唱键，不按文件名打分'},
    {'id': 15, 'warning': False, 'choice': 'workbench',
     'behavior': '只对伴奏做 rubberband，不调用 _adjust_pitch'},
    {'id': 16, 'warning': False, 'choice': 'workbench',
     'behavior': '写 manifest、cs.json，.complete 最后写；只对齐三轨'},
    {'id': 17, 'warning': False, 'choice': 'workbench',
     'behavior': 'manifest 不填 LUFS、增益、peak_limited'},
    {'id': 18, 'warning': True, 'choice': 'out-of-scope',
     'behavior': '不发 Windows toast；作品轨仍然只有人声、伴奏、原声'},
    {'id': 19, 'warning': True, 'choice': 'out-of-scope',
     'behavior': 'v1 不做云端制作'},
    {'id': 20, 'warning': False, 'choice': 'out-of-scope',
     'behavior': '不实现 /health、/jobs 协议'},
    {'id': 21, 'warning': False, 'choice': 'out-of-scope',
     'behavior': '作品目录不用「云端-」前缀'},
    {'id': 22, 'warning': False, 'choice': 'out-of-scope',
     'behavior': '入口不管关窗'},
    {'id': 23, 'warning': False, 'choice': 'out-of-scope',
     'behavior': '入口不做组件安装和 .part 续传'},
    {'id': 24, 'warning': False, 'choice': 'out-of-scope',
     'behavior': '不跑 doubao_startup'},
)

PROGRESS_STAGES = ('convert_input', 'separate', 'save', 'convert_voice', 'finalize')
WORKBENCH_PROGRESS_POINTS = (2, 10, 40, 70, 100)
NATIVE_PRESET_STEPS = {
    'library': ('big_beta5e',),
    'normal': ('big_beta5e', 'dereverb', '5_HP-Karaoke-UVR'),
    'aggressive': ('big_beta5e', 'karaoke', 'dereverb'),
}
PB_PAREN_NAMES = ('(人声).wav', '(伴奏).wav', '(原唱).wav', '(和声).wav')


def point(number):
    for item in POINTS:
        if item['id'] == number:
            return item
    raise KeyError(number)


def diff_trees(left, right):
    """返回两边字节不同或不存在的相对路径。空列表表示逐字节相同。"""
    left_files = _files(left)
    right_files = _files(right)
    names = sorted(set(left_files) | set(right_files))
    differ = []
    for name in names:
        lpath = left_files.get(name)
        rpath = right_files.get(name)
        if lpath is None or rpath is None or _read(lpath) != _read(rpath):
            differ.append(name)
    return differ


def _files(root):
    found = {}
    for dirpath, _dirs, names in os.walk(root):
        for name in names:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, '/')
            found[rel] = full
    return found


def _read(path):
    with open(path, 'rb') as handle:
        return handle.read()
