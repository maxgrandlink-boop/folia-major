# 假 msst.utils.tqdm，只给进度挂钩用。


class tqdm:
    def __init__(self, iterable=None, total=None, **kwargs):
        self.iterable = iterable
        self.total = total
        self.n = 0

    def update(self, n=1):
        self.n += n

    def close(self):
        return None
