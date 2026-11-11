# OkcErrorCode。右侧映射由 coverJobs 做，入口只发左边的码。


class OkcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message
