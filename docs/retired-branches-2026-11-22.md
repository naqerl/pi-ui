# Retired remote branches — 2026-11-22

Every remote head except `main` was deleted after the #120 → #121 → #122 stack landed as one squashed commit.
Each row records the tip that the ref pointed at before deletion, so any of them can be recreated verbatim:

```sh
git push origin <sha>:refs/heads/<branch>
```

Base: `main` at `bae8b535123feb3041b245b1d700ed8a6d16049f` when the list was taken. 264 heads retired:

| Status | Count |
| --- | --- |
| already in main (tip is an ancestor) | 23 |
| landed in main by a squash/cherry-pick (no patch missing) | 120 |
| unmerged and unreferenced by an open PR | 118 |
| stacked PR head merged in this commit | 3 |

## stacked PR head merged in this commit — 3

| Branch | Tip |
| --- | --- |
| `zeroshot/v2-404e1794665ae9938d9d` | `147b4fa4e140e490b8ddf2c991e23a0ddbb1e08a` #122 (cumulative head, landed as one squashed commit) |
| `zeroshot/v2-bdf09145d2973186ef43` | `568e5d9e3705301acdb4f01f563ba474c5474152` #120 (stacked base, closed with #122) |
| `zeroshot/v2-d35b53bd5f1c54e076e5` | `9482afca7869dc18b34eb655f85cbe20e12cfdfc` #121 (stacked on #120, closed with #122) |

## already in main (tip is an ancestor) — 23

| Branch | Tip |
| --- | --- |
| `eval/o57b-candidate` | `92091aa4314c355722b05e90ab013f274cf4878b` |
| `eval/wv3b-candidate` | `92091aa4314c355722b05e90ab013f274cf4878b` |
| `fix/mcp-zombie` | `6ed72ab0abb9209876cac9e102ec6a68493c687e` |
| `fix/restore-replay-bound` | `7452b858fe23335dc5e9ec064c6994c31e3a6df1` |
| `fix/zf4j-icons` | `c9f6d503220a5e032bb051010b42e69c192f703d` |
| `merge-all-pending` | `dfa5716ebfba73424deb0167a0cbc00d990fe233` |
| `merge/2co6` | `334993dfae54b84d2a1f035cb12cd5aa5dd74820` |
| `merge/batch5` | `e465c0342b40d552180bf747eff9a736600db7c2` |
| `merge/batch6` | `640eae22dc88a9312f0142e2cf197f1c546df848` |
| `rel-1110` | `1b83be79a2a5c59e6f5e2ebfb93b16450759cc8a` |
| `salvage/4odz-wip` | `eaa4f84cf3d1b10c0564cd8d1865b717faa3bf01` |
| `zeroshot/v2-0f8f917012e6b88e9f8a` | `b78cfd75c9463f7242f6bb5131cebee780f4736a` |
| `zeroshot/v2-1222f96875dad89ea6e9` | `97ca7e167364eebf11a47b94d1b7b874fbb0a8e5` |
| `zeroshot/v2-2aa01f1af2f7e59f07bf` | `c2ce35ac4855fbfc375d3206fb6e5e65590e85f7` |
| `zeroshot/v2-66efcb4e8a7b58a7bae2` | `f29f283f83f47ac31cb7e0e0eae3f8a6b847f3e8` |
| `zeroshot/v2-68163139bcd3056e57a3` | `bee779c22090ec940a1af73b68d55ee19602acb2` |
| `zeroshot/v2-70b24f5acda406fc576c` | `80c9307d130e3feaeba8d0b88d43d90742d253c7` |
| `zeroshot/v2-70d7fcf77c5f08328c37` | `6df7c316e8d48d42481c5825cea93591341db9fc` |
| `zeroshot/v2-8855b7d81db480a44f52` | `5fdb0125d5b0541b72739f1692fe2532f65c6eb6` |
| `zeroshot/v2-9b1541f1f7de456af7ca` | `d43ffc8b5de70580ff6e367a9d70619c402a84d6` |
| `zeroshot/v2-a055c12926c241bf2723` | `0fcdffcdb6e8f5250112170400c090a5ee099c73` |
| `zeroshot/v2-d71352b30e66efe94746` | `8619acd071c60e1cdd29d75e058ab5b875e16b93` |
| `zeroshot/v2-dc7713e94a839263c3a8` | `a412e8f26fe408ea8fad39b428eb4302b585729e` |

## landed in main by a squash/cherry-pick (no patch missing) — 120

| Branch | Tip |
| --- | --- |
| `feat/memory-tooling` | `05e306ad417f1fa3ab354951d8bfb040468262a7` |
| `rescue/candidate-7ac7c2ea` | `3891c3c9033e52f802bc46a907862a8770ddc794` |
| `rescue/candidate-r5-wv3b` | `aecfa299c9f54c9912282b66dd0458fa04314c66` |
| `zeroshot/v2-0064cee8e23d6d3ad662` | `fc9114ad26b38884c887a2b332173f922eda62d7` |
| `zeroshot/v2-00b83194ba936297669e` | `bffec15ab7382f13e99b25c7cb33de0bc597cb32` |
| `zeroshot/v2-03946c229aea1f79c304` | `de9e724c98ef148fb0cc9c2ce6c2be21b893b70a` |
| `zeroshot/v2-076df13c20b014abff1f` | `988231db0f5d2ca0903a0de75db238f8666f153a` |
| `zeroshot/v2-08eed91a5a799705c90b` | `480fdf7de0f0438abe2cfb2b409898ebfa6ca684` |
| `zeroshot/v2-09701325cbbf1c2a2591` | `a463b14933f1c7a3cc85751b52e2522ddeac855e` |
| `zeroshot/v2-0a1c4788ac91c9e6c8d2` | `2b51dfe7609de9a8dfda7753ed9d705e51448c9d` |
| `zeroshot/v2-0b9ae15a5c298816758c` | `efcb5d44bff93be85a686bb7d5361a6998dee06f` |
| `zeroshot/v2-0fe07ed21be2bd3cd7e3` | `61b106f6d00368f0f0ce33337064a7c60ce7d54e` |
| `zeroshot/v2-136e580508d8ce34623a` | `5146485b722be8b09473a136e71805d8075d6147` |
| `zeroshot/v2-18e812630e7b2806de83` | `93504020c52dd96e4c87ba68a113e46d7f505329` |
| `zeroshot/v2-18ed13546d14355a9494` | `0b243bd7e2984b15c829827dc3e364bcee3abfb6` |
| `zeroshot/v2-1b102eefc06b49de0604` | `acafd68a3feb63d739e53cac50cac24cc01b2244` |
| `zeroshot/v2-1d5a24028e9e83c7b6c6` | `68032cf33b15c67e67b13d5bf86b20328e3d59be` |
| `zeroshot/v2-1da1cda627abd3f88ec3` | `4448749ba962972db64c754209284c1bedef5c82` |
| `zeroshot/v2-1dd7b4bf2cc4147fc402` | `86e4b63ddbf22acd2c20716e1423ff3be7fd3365` |
| `zeroshot/v2-1e44f5060b43f3b87962` | `e1ceecf1862368f44e4173826368457e5b6f3e78` |
| `zeroshot/v2-20ad0f7e83aeb7a25dcd` | `18c0a0eb1cd537eb58685150bea6957b34075a7e` |
| `zeroshot/v2-21e12c3c2b0b73b4711a` | `28822e2063a34e0ea171541dc7a66320c499714e` |
| `zeroshot/v2-2222740f36f24ff11c00` | `95ebe1a6781557abef5fea0eafd2cf086ee2eaf7` |
| `zeroshot/v2-2d22e8e6eec2b60a01da` | `a4f2c7805079c6d3f3ffc176fa022df338ff5e3f` |
| `zeroshot/v2-3062243d2038bb5f4529` | `7d57fe7c106c3ee57449730e9eed2a8e8ad18694` |
| `zeroshot/v2-30f3fb2695a941e17300` | `2c92473d0fd1fe4167e458225bdaa677f6258528` |
| `zeroshot/v2-31748dbbd6459cd03857` | `5a3f9a0f719f1ab94a7e7ad965901b7fee34cdbf` |
| `zeroshot/v2-31b3ecae16e87b0da0ea` | `73c8cc70eb1da8dfed69a56396651e451ffe2df8` |
| `zeroshot/v2-37c8816dfea2e1748983` | `a0893c1e9c234a913afcbb2a0fc7725e245b6640` |
| `zeroshot/v2-392e796dbd032adbd9c0` | `13a6271733e7c63ad1700171dfc5c3040817fd6b` |
| `zeroshot/v2-399b760a6d4651c42cd3` | `c5b552bd153980af001cdc41f99e136faf2cbf33` |
| `zeroshot/v2-3c493509389117fabbc1` | `666eef3afb552f364a4614784c69ce85c5b0aa30` |
| `zeroshot/v2-3f1503a58e38465460e5` | `515238a491fc14820603dc905d82edcf4dfef2da` |
| `zeroshot/v2-400cfbd749df4a05c908` | `1008c37183d607b55736703353a427344c10f255` |
| `zeroshot/v2-40dc6ade0014eda592ff` | `e1d2af15d3f50e5e617ca0f7a94801797adea058` |
| `zeroshot/v2-4534c59b4eb4e25fffb6` | `301458f2a020069b8a9a3f28c66efd6c26375306` |
| `zeroshot/v2-47a45e73a96c16b2a9e9` | `67a2cf4738b276985ade4f46e1966b916fddd35d` |
| `zeroshot/v2-4c5727bd06176bf78f35` | `22501cb70ed120697a83317a731e8e96b46d8d13` |
| `zeroshot/v2-4e7092b37cda21c86139` | `8fdf51df3715882f1a926a5d9c38fc25721ed128` |
| `zeroshot/v2-50ba27173f7bb69ee67c` | `33854ef3a112e3c044b731683e50fcabac196942` |
| `zeroshot/v2-530de79a2e1f12301bdd` | `c986922e8b6eab9abcec28168851717b0c0502e6` |
| `zeroshot/v2-54aeca9ccf6ad80f4323` | `c44d58edd730de6f2e996f38b44af243b892e49c` |
| `zeroshot/v2-54de80f36f90243853ed` | `3891c3c9033e52f802bc46a907862a8770ddc794` |
| `zeroshot/v2-58f27f5d26994dc19e9e` | `f032fc8c7b8a12f2d7ffe9dde6292e96b1f3324f` |
| `zeroshot/v2-593459d3b55cd4306b5b` | `5ac394244af67c36390c07148378e668581b4971` |
| `zeroshot/v2-5a84bea4873cfd282a5c` | `da8f236463fbf8d14d4a69616f64edd0bfe0d369` |
| `zeroshot/v2-5b8b9459c3885589503a` | `b89894671f7c79b76ab4df97345bbe7fe153df7c` |
| `zeroshot/v2-5c6e4903549f81730bd6` | `466dca38c19d33fab8b63cfb9c16088cf9c8fee7` |
| `zeroshot/v2-5edd9bfc9079faaf6a73` | `f7901b94f2f8b4abc4b50e6df718b90c57e53042` |
| `zeroshot/v2-5f91171988fed852c59d` | `9a1f1348c4820275f309978befa5b124dd07c632` |
| `zeroshot/v2-5ffdcd5a75b3682f26b7` | `a040655eed00ce4d514731709c861413aaab4988` |
| `zeroshot/v2-607b20b92f86e038f812` | `e5321cbb27f5ef732341d355f2175057bd46bc85` |
| `zeroshot/v2-607bb8a0dde0d506357a` | `30104bda3bcc431db547eefed6b7a5c3260a7cd0` |
| `zeroshot/v2-61d9a7bd033f61670df9` | `3862b73aa4cf92a4723cd93a221c1aa799e9ab90` |
| `zeroshot/v2-6c399ac85a455c76c913` | `b304ccb489689457fe2b720469e8dcd38406c99a` |
| `zeroshot/v2-6f810efa2232c74ec397` | `593afa01a1cca09e098a567494b17a97625de62f` |
| `zeroshot/v2-7307da6b87c4137bfa16` | `5ae11f29b64f18ead0a012ea7c236d1fed472f64` |
| `zeroshot/v2-74123bd5107403d98037` | `0716b245a9ca76c39bb1fd1fe2d96f8a7fbdc951` |
| `zeroshot/v2-74d9bc70e5696c03d335` | `743d4d5a86b58a6b82afc124a8f5c544a9512bff` |
| `zeroshot/v2-75ade0c30087f0e4b8c2` | `fa0ec0216afb6f8928d455288907fe7a828a79c0` |
| `zeroshot/v2-76ae7166148a63014e94` | `a88fbf4ff6d695b474e567f26b161fdae049c533` |
| `zeroshot/v2-785c604e1d97b2d4cc36` | `ae7d0bcc98ad8d71b813759033c245faabbb5852` |
| `zeroshot/v2-7b0a82d69d8fc16f3e53` | `1b035e198a9335ad0f2a51a83db667dcb0ed3253` |
| `zeroshot/v2-7b502bd490fc55d02534` | `83b1d9de263e16685a83d241415c5155d3cd7952` |
| `zeroshot/v2-7bfff792e1294fe511cd` | `db2ed007275182fdb8eaa83ec292c91fbbf562bf` |
| `zeroshot/v2-7c1453da439cc80aa34f` | `e3e6af282e688f306f55b0d1d62507009b61634f` |
| `zeroshot/v2-7e1cef5cfe1218d61c04` | `1c5a01be523212084648442fd78f2220246b96d1` |
| `zeroshot/v2-827feb2f8e14653d0c15` | `ae34a94ed13d3581ebf171c64fe530effd322c83` |
| `zeroshot/v2-829fd2e90c3d8b750d40` | `a43494baaeeb9916a563b49a75e7d2905a087f41` |
| `zeroshot/v2-834f732d9fffdcfb6e94` | `1a9b9fcc1c0a504df5a0c5eadc06a723b32d7321` |
| `zeroshot/v2-863cb5f062b4e0d52e17` | `8e66495b52c39047c9e718a4d65884d17f56ad53` |
| `zeroshot/v2-8b8fa7d84bd9fdd39783` | `30a2cbfc13047f2d32e38d18a54c6fb10dc9816b` |
| `zeroshot/v2-8f6f714b1810b6fef5a5` | `c3da7e64a016f90c8cc227254f16089e783cca14` |
| `zeroshot/v2-96e03be75ed88994cc05` | `795f9684568855227c16e6eee216e1193cdfa009` |
| `zeroshot/v2-98d35a2d756b9925f202` | `0b4ca028eae73d87b0345f525a7779aca6c7e922` |
| `zeroshot/v2-9af62fc1aff0ea8c3ef1` | `ef46fc4441af572f77f578961ca77857335c7c90` |
| `zeroshot/v2-9c7111db35454d57c2ef` | `b6f0079c829d5a6bfadca3456ee9f97c12dee7c2` |
| `zeroshot/v2-9fd38320d32adc5284cb` | `38fa09cfa3e973d02b5b6ceafd0ca2f15c5b8afc` |
| `zeroshot/v2-9ff9bccc6b84cc66ae9e` | `bd75f9c903c62955bcf82261253e5912c993b94d` |
| `zeroshot/v2-a69fceb912fd5eb19822` | `646a5bdb568b3676b8f82b176e03e3c608fbfc61` |
| `zeroshot/v2-ad124d3e0c0bd92b67cf` | `b908c31bc7ab83ff26d85e85e28139065d694cf9` |
| `zeroshot/v2-ae85dea50b1987f92f42` | `a135edb926ebca490b5735747bc79408b16ee9dd` |
| `zeroshot/v2-aecb17ff1d5dd19d0601` | `3706e2cee836ba06f38e41bf28f4800c49c2a84f` |
| `zeroshot/v2-af5c4478ddcaa89862c0` | `c68e1e45f98c3b1233f6f4df44cd5028389eb18b` |
| `zeroshot/v2-b25b7251c5a1cb3f4066` | `71675e2191fae1ee7b963b85cc7d2c7492149ad6` |
| `zeroshot/v2-b80cd27bf27ab5be1492` | `f8ccb53715a40184cbedbdf4facb7ce86fa67d00` |
| `zeroshot/v2-bc08dc6c74036c2631fd` | `dff5c292bf2e370e2abbbb80d94b5873ce775598` |
| `zeroshot/v2-bf23478a96d34da7e388` | `d14fa61cf553fa5d5bf8c54e1a15373dfaddc892` |
| `zeroshot/v2-c299fd184e57c878daed` | `9e7a9e2bc9854ec4f709bfd3e998d2a5af941c9a` |
| `zeroshot/v2-c4f309ade2ac50c49e8c` | `efd53d429b569925b6d8d067304071aa9d969ed0` |
| `zeroshot/v2-c6e407e026da96ad88c4` | `352da4bc533e432a095bf9653aa138ab590797ef` |
| `zeroshot/v2-c962a31395fbe7fa25cc` | `e83d7e1dfbaad5d9b3f9c5e182891c5921fddad5` |
| `zeroshot/v2-ca1b6d6a68faa0b81cde` | `3101367bb4053d87d30e48bff42be4e72c611f17` |
| `zeroshot/v2-cacf586e5f33fccd4ab1` | `7f000e7a94a5635531d72fab31b56629b7277b84` |
| `zeroshot/v2-cd9f4fd27a7e211047ec` | `5f7738da49b77881e769311fb3cba5958c67bf05` |
| `zeroshot/v2-d25cc1be7e0fa4867df1` | `8aa671a5e07c49f05ca8ff03a162af5302853ca5` |
| `zeroshot/v2-d63dc64f692fc4938a00` | `8fffebef271ee1061f61ccaa5c21e0bedca3f79f` |
| `zeroshot/v2-d89cdc4ffd50e3169e38` | `77667922743e521905ba29e4346c5101f295be9e` |
| `zeroshot/v2-d8df2a8af14204205475` | `c82f560b795adb565e8e2935e52f8039fc875e63` |
| `zeroshot/v2-d9149fd5ac5edfd44e9e` | `92ee25496ca369489e93c631a3a36f9e0ed287e7` |
| `zeroshot/v2-d98f52d92bf1287382f5` | `2a378528fc84b266272b4c95355d6abcfa5a683d` |
| `zeroshot/v2-dc5ab7192807c33449cc` | `6743346bf37fb63bfbddb3b488eb74df1667fbb8` |
| `zeroshot/v2-dd330bc2462ad7a4ca6c` | `73d7905cde3a8eced97ce4ffbdb2458fb80663dd` |
| `zeroshot/v2-ddafd39e431bfaccaed5` | `5674688c80a6b55be46db15559408f53377f7a01` |
| `zeroshot/v2-dea1d8dcbb075aeeef86` | `89f7997de6e1b916a51094aaafca2dcd6fd29998` |
| `zeroshot/v2-e32028abce38bb7a0958` | `67b446b7151b795eaf2832fdc00e2187de871a6b` |
| `zeroshot/v2-e6b3ed543e6ba0208eeb` | `227530bd4b8216911847a94b84c501480b078d59` |
| `zeroshot/v2-e762545dcd0300a79b49` | `c70079294ccc6cda4163c684efc809210293e9a0` |
| `zeroshot/v2-e8011de7bfaf7942595c` | `73852ba0080fae24ceee480ef277d22bc7892482` |
| `zeroshot/v2-e98ef9d34aed5dbe89f6` | `aecfa299c9f54c9912282b66dd0458fa04314c66` |
| `zeroshot/v2-ed4edf2fe57dbe57031f` | `b0ff4d291de11f923c522e0efd65f1df7572498f` |
| `zeroshot/v2-ef159ce8361ccd3a117c` | `c8c9c2dc82bec8d2427c1fb4ac1dff86e8b65bf4` |
| `zeroshot/v2-f30f60388f84f4cce90f` | `2b414b041070019c7377126d62029cee5824ac40` |
| `zeroshot/v2-f53ae535123849fb597d` | `ef9ee403842f7b8a46a05f8b20f52fc0a7709866` |
| `zeroshot/v2-f645922a3a8a2056e00f` | `5e953ba9d2a6caf0126d27248ae8d6b9dc297c88` |
| `zeroshot/v2-f71dda9ba7be5efdb29d` | `1a52cf385a610d0071631ad23def364cf655e73d` |
| `zeroshot/v2-f789b38cf11b700ab7b3` | `b6084140351ead34cd8a1725942a6073a3bf3d07` |
| `zeroshot/v2-fc782769caea55835756` | `52396f7eba79759bd207b4c9e4c1e539decaa266` |
| `zeroshot/v2-fdda27f8fb424c457d8f` | `57e4b0f5376838704db6b1ae89633946c684f9ef` |
| `zeroshot/v2-feb0251f2c139a2454b3` | `7d24ea85bef33a87df18fe0ad196c32f6434025c` |

## unmerged and unreferenced by an open PR — 118

| Branch | Tip |
| --- | --- |
| `feat/bili-bridge` | `6bc67c4da7308382b0241a4df3962290e5a2dd47` |
| `feat/bridge-pins` | `87a95dc3bb61baaeff434236a565628b19721d73` |
| `feat/composer-ux` | `9b9f773b7e9a5c45764e34f5d1fd8157b97b6109` |
| `feat/composer-ux2` | `6c3ae426d4769c40ec39327cafa7753d626e9a51` |
| `feat/docker-release` | `2f6a42ead316739d5f7c312bc6266ae21bef35e5` |
| `feat/durability-e2e-md` | `44a2fa1cd5a4ee5745707732c900730a989a3675` |
| `feat/durable-host` | `2f6a42ead316739d5f7c312bc6266ae21bef35e5` |
| `feat/footer-surface` | `607b8504f0922a162a371373eae07886c2dcc27c` |
| `feat/markdown-whitespace` | `9b9f773b7e9a5c45764e34f5d1fd8157b97b6109` |
| `feat/mcp-bridge` | `9b9f773b7e9a5c45764e34f5d1fd8157b97b6109` |
| `feat/mcp-runtime-contract` | `4633fe47170028bedf496cba115877e76945e913` |
| `feat/surface-backdrop` | `06ea6214956f62ed3249883fd9805fbcbd3638bc` |
| `feat/ux-working-indicator` | `6bc67c4da7308382b0241a4df3962290e5a2dd47` |
| `feat/web-bridge` | `4d3ade0640f598ff07e668b39bb3542719abe8e8` |
| `rescue/candidate-2d130205` | `fc4971548dd2502f018bd452b54f413b940a4391` |
| `rescue/candidate-610b99a9` | `cfd34670a2e26d743020c87dc1a769ca862229e8` |
| `rescue/candidate-cfbd3352` | `66766f42cfb3db6e6e5b6605ee8a5d9321697330` |
| `rescue/candidate-r5-o57b` | `6779fe362c6c83ec537f34010e34257749bc8a22` |
| `rescue/prep-20261119` | `7a33914e2ffdcd03301ef0418a526e1ebb9a52dc` |
| `zeroshot/v2-040e9a37d2e1aae11c81` | `6779fe362c6c83ec537f34010e34257749bc8a22` |
| `zeroshot/v2-05aa5cc271084186e656` | `66766f42cfb3db6e6e5b6605ee8a5d9321697330` |
| `zeroshot/v2-08e60a2d471f73dd840b` | `254da37ea3ba450416f909eaceb481f0fe7cdb8e` |
| `zeroshot/v2-098fb9e6fa306c8fcc3e` | `14965df00f7cbef6e943b1e95e9d4f3eecca6597` |
| `zeroshot/v2-0ad9086fd759623ed31b` | `d8dc8b154120f88a90a71f7191b5dee4714bc869` |
| `zeroshot/v2-0c4c77fb6faf1968d9fc` | `7efb7c37fffd4f449a460e2a2b8173d1dda6c3b9` |
| `zeroshot/v2-0c9dcb481fa2e3a3730f` | `56d49db2fe004d151ae18575f5406c308e5f1e23` |
| `zeroshot/v2-0c9f1bc78ce02cf100dd` | `31a0784a670339501a1aa837f58fcc9abd6cccfe` |
| `zeroshot/v2-0fc55d506ef8d1f3d908` | `88122eb90db4b45ebae5e452e88dee0438247146` |
| `zeroshot/v2-10b87f08a1279e20f1c2` | `1dcf49d5b4fc885f876fc8a8a05911dfe73fc92d` |
| `zeroshot/v2-10cda6be6c002ab20606` | `9b5cbfee0ad2e804a7e06e18cd8904f734afeacc` |
| `zeroshot/v2-1233822bb61223065cd7` | `6d495652e810fd02d36080470a160483a359a319` |
| `zeroshot/v2-15867905b6a5b2fe289a` | `8b754860e63a8dbe6640b36eb3fe511cde95e00a` |
| `zeroshot/v2-160a94eb9f088c2f89af` | `4657bbe0d83c2a0b75f0c37829e22a083090af38` |
| `zeroshot/v2-16d4040d2d70c8f0afb1` | `44a2fa1cd5a4ee5745707732c900730a989a3675` |
| `zeroshot/v2-1dd99d015ec311844fb4` | `97f057981a32b508598075f8052b13f5ff1b7c54` |
| `zeroshot/v2-1fa1f0d5eb6be7874ae5` | `bc4f64adf92096639aa9e67fedfe5941c21b1358` |
| `zeroshot/v2-22116393a99cb8e33467` | `9b5cbfee0ad2e804a7e06e18cd8904f734afeacc` |
| `zeroshot/v2-2272ebf25a9cb09c3b2e` | `6b6b3c6808263f37c90c063033e3fe9c79b91d00` |
| `zeroshot/v2-22cade9f91d2f9d10ce8` | `bf6f8b67ee0b36407c113b4e524fec02c277f76b` |
| `zeroshot/v2-25c21cdf2078a7dcd2a8` | `c30f0cd3b91b7d9f3130a03bcf70d63baa589f55` |
| `zeroshot/v2-2946cc4f8fb7671857d7` | `41f66aac45307a7babd4eff8ba0915cef599c0e7` |
| `zeroshot/v2-2f133b9f0f58d439995f` | `68a73edc274f14e13ea92593465eab2edef4d26c` |
| `zeroshot/v2-2fa168b74b8f966dd971` | `f915033fa333d16b7e9a4af57188a1085142cac5` |
| `zeroshot/v2-31c383fe4be96e92f563` | `87b155c75ec59613b7624fa22858941b90e711f8` |
| `zeroshot/v2-32db98ca4cfc3da927fe` | `6c3ae426d4769c40ec39327cafa7753d626e9a51` |
| `zeroshot/v2-3b970b54db67b29fb97c` | `21894f6495b04dcff1f65f56999c59949f70ff52` |
| `zeroshot/v2-3db80243a5c5cd1fa702` | `a85569b99e304558fa03037c6668cd1088f8832e` |
| `zeroshot/v2-4421ce00f7232bd0119a` | `a4576aff324c63417e6a2e4833c933d39daf1e2b` |
| `zeroshot/v2-44da2a4957b395d63753` | `4bff5adcefa8d7fe61173d18d6e31909500078c0` |
| `zeroshot/v2-48e278b1611e86c5543e` | `1615195ff96ea603521fd8a758d7ad4a4d38137f` |
| `zeroshot/v2-4ab31276572538adf0f3` | `a90a277083c19e500d354a334d796c22340ff0f1` |
| `zeroshot/v2-4c9972358cc4c84010b6` | `97cc32a1a48ae903e64e1bb5c4d5a294b1bb6558` |
| `zeroshot/v2-5727cf3ee807e086724a` | `7e4fbb7572bd3d5fc3c7806cc2a218c3120bee87` |
| `zeroshot/v2-5942be7d8b46b78e2d53` | `6bc67c4da7308382b0241a4df3962290e5a2dd47` |
| `zeroshot/v2-5d02a1fca462a635d5cd` | `f1e07d2f38c85dc1c8026ba104ed5fb7033878aa` |
| `zeroshot/v2-5e078969e1e337caad60` | `05ac1df98a359cb48646660a16faca21c2a1ad32` |
| `zeroshot/v2-636980d8550309c31fc3` | `8ac69a9da5d56905edeca9b9aa75e4999fa03cad` |
| `zeroshot/v2-6558317de80cbf85ae5a` | `8b7d4b047d570b7c0e581e3fd83adc636e28c517` |
| `zeroshot/v2-6778b97b3821f3f1dfc6` | `fb5a6d598dae7a676d13b87b7a216792ac456ab4` |
| `zeroshot/v2-6f4a93b09546eec16751` | `d580f3b21fe0cb6608b97cad9657dd3636ae6f93` |
| `zeroshot/v2-72e8eec2f41f2e2ac855` | `3c8dc161e050eb3e04e1829e04c30390969b9dc6` |
| `zeroshot/v2-73e923cffa2873eb973b` | `f4c5e221e2ff6d643bfe4ff57e654d0432d6e123` |
| `zeroshot/v2-760c04355ca02ab5d3a5` | `f92f748ea796c3f6a66e864cdaacc4e98b555598` |
| `zeroshot/v2-769fc9780b02488ce9f7` | `d2bd3213dfe954707c36c8251cf1d5549bee8810` |
| `zeroshot/v2-7af2bd4700c48a601fae` | `0d3a6f1925ed30a5d3970d36c3292665c94956fc` |
| `zeroshot/v2-7ca6d32ec848ffebebcc` | `01f0101febf9dabf137ca65d7243016d0873f332` |
| `zeroshot/v2-7d06322bdc7df1642687` | `22e8d63f236f85e46fc38f99c94ca5ee651fbfa8` |
| `zeroshot/v2-7d9a31bf03ecf7336100` | `4f1feaba89bbdc5e9d79cae9ba0b873d34435af3` |
| `zeroshot/v2-7ff12f0f4bbb947d1a8a` | `4633fe47170028bedf496cba115877e76945e913` |
| `zeroshot/v2-81eacc9fd0f976f6b55d` | `4456c3dd48d59277859b429c135afbd91eb91843` |
| `zeroshot/v2-8839ab901acc05dbdd9c` | `3c3939194316cf2f717c3994b01cb5e0967e3d0b` |
| `zeroshot/v2-8abfb5755b89d92400eb` | `70fb30b4a1d835d4d4c04107550570ebece5525f` |
| `zeroshot/v2-8ad33f00389319b5f84b` | `cfd34670a2e26d743020c87dc1a769ca862229e8` |
| `zeroshot/v2-8b7bb6e327e6ade41c15` | `97024de9f812d7bc32dd7ab7a6e0581cfbcb0552` |
| `zeroshot/v2-8c3bcb7b3aa669a4f1ba` | `ed90f540c891321782e1036d55d1a1515990d8b4` |
| `zeroshot/v2-8e5e7697db5c70d87ebc` | `fc4971548dd2502f018bd452b54f413b940a4391` |
| `zeroshot/v2-8ebaa886f2efe971920f` | `90bee1c949b8664404e836847db57b659431f5e3` |
| `zeroshot/v2-8fc745ad2fdabe45d69e` | `ad8cad0203ca750252f9b10ddf852cc32b69dcbd` |
| `zeroshot/v2-9088a84dd3345ee89442` | `5bf3d7df8d33bd4ac345f44a9c14e40ffd1434fa` |
| `zeroshot/v2-90f4c2cfcc8bbe1c3184` | `25aa11e19f64f87bf260f8c5249817917bd50d9a` |
| `zeroshot/v2-99790f35fd23dbe87d72` | `fbe9647d78b34a4c4985e4ffadd42ffa8d70a033` |
| `zeroshot/v2-a07e195db7ddd904a240` | `0a24e7100c78f1c658c69d348f6a692035b46a9e` |
| `zeroshot/v2-a106f5e1f6929c6b9d0a` | `f2a4e31285c4211723f06066c18e7b93260702fd` |
| `zeroshot/v2-a17048089143bda60ecc` | `eed621d52022533d8fbd194fe43bdc0c1296fb3a` |
| `zeroshot/v2-a187b11f6ff4c2e46697` | `cd1fef97c29cf5076fd743f5dbc3f2c39aa7faa7` |
| `zeroshot/v2-a5701ce15fe619aafa91` | `30fcf3ad17482efc9ac4291a5c68a0e094083215` |
| `zeroshot/v2-a7c8268ea6c1d19a0912` | `36437d0a998f4c4750842081e6e2837bd8f9ec00` |
| `zeroshot/v2-a978648b9b5ccf90f1cd` | `f5b7f2c8ade3dbdc4cc156177988b772e33c6054` |
| `zeroshot/v2-ac336979091c62d9a601` | `c74cf77d63a94e4b8f7fafb914a3c2c323ee818a` |
| `zeroshot/v2-ad51c837f63936c9e864` | `9b9f773b7e9a5c45764e34f5d1fd8157b97b6109` |
| `zeroshot/v2-ad9c811e07275ba04430` | `d2eab208d899a2c2a8f0eabea8a1f1e621aa7630` |
| `zeroshot/v2-ae478132cd530f107ef3` | `810a20303cad456a0c6d7198c6d11f97d2a69450` |
| `zeroshot/v2-af939b52b4da7f6eb2da` | `c30e208e38cb770bf89a537f03f6f0696d58f525` |
| `zeroshot/v2-b78f191ba062bf2a3318` | `f86d8cc2692ff791a27d6e52b2dc973363c513b1` |
| `zeroshot/v2-b9961fe264c6c892fae9` | `b280c2e12de58ad4032906a4e159fd6c653861b8` |
| `zeroshot/v2-ba10625f2d1e464a0e6d` | `29fc1a2e237f286aaddad159b79c99c46d9db668` |
| `zeroshot/v2-c11a1fe8d7faf2537b83` | `6a4aab35ea119cab3898ae46c1ac276f7b22b37c` |
| `zeroshot/v2-c3a3b0fc96b132f66357` | `d12230b87fac9a9e36e2f91e2b74b45ca1c32ede` |
| `zeroshot/v2-c828aa5ddf7bc3410d30` | `6fdaef71ea1e19e19bacb1cc1f374c5dd2cc3a96` |
| `zeroshot/v2-c97dab793d7d67cfa612` | `f0848a71a57fa5436249e49c1133a1db33940833` |
| `zeroshot/v2-c9c14e1f8608fb78b933` | `5351373bcc93c25b53b3de7d6c96b27abbd3fe99` |
| `zeroshot/v2-cc0bfd59f266bfcd1397` | `3af1e53af17e2a22a13a889f01235b075866ea76` |
| `zeroshot/v2-ccb0745ad8fb03c38474` | `4558f75b99d195fea9be1981b979e17c02a969c4` |
| `zeroshot/v2-cf05882152c8f1d37e07` | `eaceace8a5c3095364c4bef7966626be061ec963` |
| `zeroshot/v2-cfe6f0948a44eff0f8d6` | `ef0ccc93012ce6ccccf6a91835f3d9db24fa2a5a` |
| `zeroshot/v2-d18c358da5c6a4ab8afa` | `87a95dc3bb61baaeff434236a565628b19721d73` |
| `zeroshot/v2-d6444c1fe52dfa00bfd9` | `6f4c6c2d2be681bc609a9f49dc9b2801178bda37` |
| `zeroshot/v2-dd22bcf904bfb73c164d` | `aa4649d5c0b24b37318e8d6a85a1038be31fc416` |
| `zeroshot/v2-ddce7b325c3c9526cf10` | `fc10b70fee6abd293a76d7cd2c421f26cd4425e6` |
| `zeroshot/v2-dfd129884a63c60a307a` | `5f468a0eb4a9f05fe5ff74006c7c3c643f909044` |
| `zeroshot/v2-e04a1de01d93832ce508` | `03b11d5674b65c1d4a326b5f665b1ebee9fa41cb` |
| `zeroshot/v2-e1df979502952f51721b` | `d7efff1a7dadb5281eacf75fca46a4647317049c` |
| `zeroshot/v2-e314e71cbdb772a9ece3` | `f83a3fe93354489e103c24dd65234cd0570af20e` |
| `zeroshot/v2-ead4366283fa15ec342f` | `f86d8cc2692ff791a27d6e52b2dc973363c513b1` |
| `zeroshot/v2-f000c5488cf81dcccf87` | `db8b9efbb608f18229709b3afe6513d1e6f97785` |
| `zeroshot/v2-f671dbe94413ee457c72` | `923a6f2ed7640f421df52dea7f7a908ee9390e25` |
| `zeroshot/v2-f7d5630d3febc5596739` | `e4fe10b85b88f334e9bc90a7e84897861ad6718d` |
| `zeroshot/v2-fe34165bc211de501b60` | `06ea6214956f62ed3249883fd9805fbcbd3638bc` |
