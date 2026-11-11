import argparse
import os
import sys

from okcover.redirect import install

# ok唱歌翻唱入口。用法：python -u -X utf8 okcover_entry.py --config <okc_config.json> | --selftest


def main(argv=None):
    proto = install()
    args = _parse(argv if argv is not None else sys.argv[1:])
    backend_dir = os.environ.get('OKCOVER_BACKEND_DIR') or os.path.dirname(os.path.abspath(__file__))
    if args.selftest:
        from okcover.selftest import run
        return run(proto, backend_dir)
    if args.probe_model:
        from okcover.protocol import emit, result_error
        emit(proto, result_error('library', 'INTERNAL', '--probe-model 不在 P1'))
        return 1
    if not args.config:
        from okcover.protocol import emit, result_error
        emit(proto, result_error('library', 'CONFIG_INVALID', '需要 --config 或 --selftest'))
        return 1
    from okcover.job import run
    return run(proto, args.config, backend_dir)


def _parse(argv):
    parser = argparse.ArgumentParser(prog='okcover_entry', allow_abbrev=False)
    parser.add_argument('--config', default=None)
    parser.add_argument('--selftest', action='store_true')
    parser.add_argument('--probe-model', default=None)
    return parser.parse_args(argv)


if __name__ == '__main__':
    sys.exit(main())
