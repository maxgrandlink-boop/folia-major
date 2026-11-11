import os

# D11：同一输入、同一参数，entry 的 PB 产物应与直接跑 api_wrapper.py 逐字节相同。
# 设计稿第 7 节：工作台给 PB 打过哪些补丁还没核实，等价基线要等实机 T0 的 pb-diff.txt。
# 这里只留比对函数。本仓库不跑真 PB，也不下载权重。

D11_STATUS = 'blocked-on-workbench-patch'


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
