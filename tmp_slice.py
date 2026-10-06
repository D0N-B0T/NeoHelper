import io, sys
p, a, b = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
L = io.open(p, encoding="utf-8").read().splitlines()
for i, l in enumerate(L[a - 1:b], a):
    print("%d: %s" % (i, l))
