"""MangaDex: sole site-specific adapter; series verified from seed chapter.

Chapter traversal and rendered panel filenames are verified against MangaDex's
public API. The normal Chrome/Comic Bridge profile, state, checksums, and
publishing infrastructure are reused unchanged. No chapter URLs are guessed.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlsplit, urljoin
import re
import threading
import time
import requests
from bs4 import BeautifulSoup

SOURCE_BROWSER_TRANSPORT = 'extension'
SOURCE_NAME = 'mangadex-my-wife-is-from-a-thousand-years-ago-en'
STATE_STORAGE_MODE = 'scoped'
TITLE_ADAPTER_VERSION = 'mangadex-my-wife-native-menu-v1'
SERIES_SLUG_HINT = 'my-wife-is-from-a-thousand-years-ago'
_SERIES_TITLE = 'My Wife Is From a Thousand Years Ago'
_MANGA = '17a56d33-9443-433a-9e0d-70459893ed8f'
_GROUP = '3ab21bf7-e351-4f18-a54c-11b2b7e5c439'
# Native chapter-menu UUIDs from the supplied chapter-1 HTML, not generated IDs.
# The complete English reader list at capture time includes both prologues.
_CAPTURED_CHAPTERS = {
    '0': '2185dc26-72ee-4027-903b-7a0df46c2df5',
    '0.5': 'b054f531-f0ee-4bd8-8d47-af7da1c8628d',
    '1': '61f1d297-3b3b-4d83-87a2-9ab68b709d35',
    '2': 'f0dd560d-0d94-498f-a2c5-1ae8b2af1c37',
    '3': '97a53d8d-3e72-42a9-90b3-b3b6ce4bea79',
    '4': 'babc2168-3cb1-4ebf-870f-4fef4278eb2d',
    '5': 'a29864c5-ce81-4b51-b1e6-d2f59c9fa0f4',
    '6': '953e9109-0b85-4cd3-851c-196ade5db3b8',
    '7': '87f03893-a685-4f0a-8962-61885679c1cc',
    '8': '80e53666-8e81-43f2-afe6-4a8819d59897',
    '9': 'c345fcc9-584f-4c04-a1ee-a4a8c64e111f',
    '10': '8c7640df-7d8a-438b-aff5-788d6669f892',
    '11': '078c5691-b27a-4c5f-9ccb-2dba9bfa6832',
    '12': '5fc8f7df-d8ff-4447-8e77-f5cf8815b120',
    '13': '4c3026fc-7e49-4a09-b8d6-6f06d38384c9',
    '14': '19ce7f0f-44a0-403b-b723-f04aa9bb0e78',
    '15': 'a49fb9e8-737e-468a-8028-933fa480dc36',
    '16': 'c50b0222-6219-4984-84f6-bd89182da230',
    '17': '96963ff8-5831-49b2-9137-b6be6ea679a3',
    '18': '48ebd544-56d6-40c7-8b17-1f0c167d5e3e',
    '19': 'f1f17c1a-7509-453d-afcf-4fcfc5f50af1',
    '20': '7dc8b833-8b34-41fc-916c-30daf4d34fe9',
    '21': 'bb11481e-3b0a-4a32-814f-46d2d1c318d3',
    '22': '71adca6d-3eb1-4427-8ee6-5eee992f78be',
    '23': 'a54f156b-0305-43f3-90f0-f3d7f8054ce1',
    '24': '536acff6-9957-47b9-bd31-fd63ca7af254',
    '25': '26a980bb-2929-421a-a55f-596add536241',
    '26': '13ca2a06-c144-411c-ad31-3b04fe8ef3a2',
    '27': '713775b6-e3a3-4db3-94a0-cfbb95cdce6d',
    '28': '31dfe2ee-cd57-482f-addb-1290cae0a647',
    '29': 'a1297cb4-bca7-4efe-a391-d037b23c8c58',
    '30': 'c3293870-5c92-4559-bbb9-333e9f77b21a',
    '31': '8abc2acf-9d20-4ebc-86f9-d03cd38a0dcf',
    '32': 'bdb9eeb9-07bc-43c9-84f7-272653d2ecf1',
    '33': '064dc2a1-5cc5-4e81-810e-b19bf0cf864e',
    '34': 'bc5f071f-de9e-4641-8ddf-3c6f62e0663e',
    '35': '0b502864-7379-43c7-915a-689dc09d4ab2',
    '36': '84aba0ad-9449-4b8a-b2f3-7164f68343f8',
    '37': '3716fcf0-8594-455f-9f64-792c9c502171',
    '38': '1304eb9b-1a03-4f12-9032-91d6cdb878c9',
    '39': 'a7403941-2097-4013-9ba7-914a4cba0224',
    '40': '73210bad-5d44-4611-9b3a-09b378b8d1c4',
    '41': '3d8cd247-db3d-4684-b915-2079e736f74c',
    '42': 'b6a7849f-c4c6-4c06-89c3-f077cae976d2',
    '43': 'c33eae49-f9d1-4367-bb78-9b2b47d441dd',
    '44': 'caeaf554-1438-4552-b887-8b81f8548706',
    '45': '39604a8f-b1f6-4380-a2ed-a71fe47b8a22',
    '46': 'e93e6201-0121-4c28-8b4f-efa47f8a3125',
    '47': '75ff3946-6dfc-4a6a-b70b-44962a3d648c',
    '48': '4a78b832-b0a7-4e23-8e99-e353312045bb',
    '49': '076d32f1-9130-4c85-879b-abb1d6a6b035',
    '50': '857fed9b-8cd4-4557-b132-a7c19d6d0963',
    '51': '52b28761-db8b-4fd7-9f41-ebf73bacbad7',
    '52': 'b66c7317-0333-4c7b-b4aa-7222fdf45302',
    '53': '34687c15-ace2-4061-81d0-c5cd7b038371',
    '54': '08447ab9-cd38-491f-9e57-8b52010d4e8e',
    '55': '286b2cba-1170-4ae9-9753-9bf6d2d58541',
    '56': 'b1774d83-55a8-4c74-bc96-a0a2e6d6336b',
    '57': '6b939397-ccb0-46ba-9572-da690906e271',
    '58': '93655bfd-409d-42ef-90cb-84c0f8311425',
    '59': '9e8bf2a9-8b2c-4cae-8dd6-a36e5cd76a7a',
    '60': '461823fc-6b35-4830-b017-689d9efa7726',
    '61': 'ad08d4b1-ea9d-41c9-87d0-e36c4a014474',
    '62': '7dd5b87a-2108-4199-ac62-b594ac86a825',
    '63': '36e79741-917a-41a6-9098-3d94040cb4b0',
    '64': '6117e8dc-4eab-4c60-a2e5-01c5bec862df',
    '65': '5cec9e58-dcb5-4aa6-ad80-de439b1330b6',
    '66': 'b44120c8-a109-4fea-8819-8823998dd2f9',
    '67': '7e92d820-f547-4e65-92a0-fee39a4a1d18',
    '68': 'a1d069fc-df71-4f3e-8a4c-03e0007ed404',
    '69': 'd014bd29-5102-4197-9ecc-e4bffcaabeb4',
    '70': 'f9a7c37e-05b1-444d-89b5-b59223d3e49b',
    '71': '0156627a-eedd-4264-8361-ac0cb1606425',
    '72': '0dde6155-a238-4f47-a454-f88e7b4c98a8',
    '73': 'a5569a42-7c13-4ec1-a976-deb130f50868',
    '74': 'c58477a0-838c-4fdd-9313-abf5db78f6b2',
    '75': '5886d859-4a53-4d71-b5f6-19b85ea66933',
    '76': '13f8b748-ccd5-4d5e-8145-dc7c14478c9d',
    '77': '8cf936e0-0771-4103-99b5-3ed9d47c0494',
    '78': 'ca4a7c45-fc34-45a9-9648-726f4497157c',
    '79': 'd5dd5c3c-90b7-4f34-a152-a28d0d53404c',
    '80': 'd2ef8394-b14f-4b57-a9f2-56267770ccca',
    '81': '69aeb524-4ca9-49cd-bd22-fd6bf78e832f',
    '82': '8a82fe51-7f9e-495f-9616-ffc22d3a52d2',
    '83': 'a476451d-14e7-4f02-8b3c-d0ec89b36bed',
    '84': 'c166969f-736d-45ff-bdc1-2298e6480bc0',
    '85': '3e4cd1b8-6fe2-4c23-95ef-96fdcda1c99e',
    '86': '775b404e-7d60-4c4a-ae35-f77f2e8aec05',
    '87': 'bc4cf27d-3070-4b0c-9d64-d1719870772b',
    '88': '9ffd09a2-9a2b-46e4-9294-258c178d4054',
    '89': 'b8a21ad4-b929-4c89-88d2-6c000f510d0c',
    '90': '42f17e01-fc04-4a0d-be4f-5a60aaeccd7e',
    '91': 'e67f396f-9b11-4a11-80d1-27ce37f0ce44',
    '92': '4198958d-0077-44de-b15c-589acdf00b35',
    '93': '3f5eea5d-248e-4726-9df1-dff91448dfeb',
    '94': 'bd6f37f3-9b11-4710-abe9-2bf4df0fe400',
    '95': '59484e07-dd35-4c5c-b3f9-687f7c9c5809',
    '96': 'bd44fdf2-f4c7-490e-addd-6eb28a76015c',
    '97': '1c33202b-1940-4028-8255-482bec1e898e',
    '98': '835b2182-cf6f-41b8-bdce-41e5917753fd',
    '99': '0dd234d3-91d8-4eb8-a0dc-f21be0adb23c',
    '100': '4a2ae7af-619a-40d0-9fc6-289dd6205554',
    '101': '759f0a44-5795-479f-8fe1-7fdcd4f7d088',
    '102': '2c4e5ad4-0713-4b7f-af0c-88378217aa4c',
    '103': '4f03f631-8513-4db1-ae2e-ea60a6f120a1',
    '104': '33711c49-d550-49a8-8fd3-948a606f9855',
    '105': '834be545-47c5-461d-9838-ba814e80caa5',
    '106': '02f7516b-57f0-43f1-a609-ef2d7bad2674',
    '107': '60372c1a-92a6-4819-8943-922e8be0a49c',
    '108': 'e12dee34-14e7-4d4d-b1c6-0198d8564505',
    '109': '13ffa79d-4c56-487d-a0d2-ae1e96fb8794',
    '110': '820cab3e-7061-43d3-9fb9-c4f8cd23c028',
    '111': 'df36adcb-186a-4005-bdf0-7b83265f9ffc',
    '112': 'caaffd0a-5288-4fcd-acf6-d9d353e37fe3',
    '113': 'c5c379d9-efb2-4ecb-a7a3-04c1f642e308',
    '114': 'f5e57d8c-e0ec-4ea0-a8c3-37315b47caac',
    '115': '86d6cc29-0b5b-4106-a61c-e7e1d3116550',
    '116': '47c077c9-36e6-40fe-b1a2-f6c758163e52',
    '117': 'eb0a22ab-8779-43d4-a499-138532a05380',
    '118': '5d2e5a32-f490-49f2-b71c-a40534d69773',
    '119': 'b799317d-b964-41c9-badf-880ee59f0fc0',
    '120': 'a96252ca-a98a-4a44-b730-cdf56e377ca1',
    '121': 'f9b9ff7d-7e58-44af-82de-84b94a13d4b0',
    '122': '52550a84-fab2-4dc7-a58f-37f3b61c3b6b',
    '123': 'c655edc3-3775-4e62-b4b7-9b67b197bd98',
    '124': '3a36a176-dca2-432c-abe5-9fd563ec6e77',
    '125': '61cbfd59-2a22-46e8-bd76-dd50e667b836',
    '126': 'de5ae68a-c205-4e29-aba5-7de52a553122',
    '127': '39a0f2fb-ad52-4070-a084-0a8be807c0f9',
    '128': '9b4c60ce-a59e-48bb-8fbe-4b4729f4d7b9',
    '129': '41b0fe87-81cb-4fb7-abc5-546f26a41f2f',
    '130': '449a3313-d3c9-4a1f-8440-e7536262791b',
    '131': '1767d286-b54c-4bf7-ace8-005e045f4cbd',
    '132': 'db73ae1e-a818-484f-bb70-eda0abc08811',
    '133': '229f146a-4a79-45b1-b64d-068775b526be',
    '134': 'c749a67b-2a84-421f-a618-acbe19727448',
    '135': '16423ee1-a70f-499f-b2b1-55fcd1a962b4',
    '136': 'e1497ca5-a7e8-4ffe-985f-8aadd9b7d2c1',
    '137': '43657b71-714e-4cfb-ba00-50ce2583f4ea',
    '138': 'bfe95b19-50ad-4890-aae8-029d7c97f1e1',
    '139': 'c93d1cc3-a4e1-4adb-a9d9-19d376cca3c9',
    '140': 'df89811f-91a7-404e-aa2e-17b914470d71',
    '141': '79f56c58-7b8f-4d4c-b6a9-80d327801155',
    '142': '7d010771-f642-4651-afdd-72bf422fb387',
    '143': '22543e43-078c-44d3-81dd-be95771603aa',
    '144': 'c206fe09-66d8-4702-ae62-27f81aeefa87',
    '145': '07b15742-b7af-4b95-8e66-da4f91f0610a',
    '146': 'c61172f7-5c2d-4bcd-a316-52afbfd1b50f',
    '147': 'ec2de59a-8e61-4167-a16b-43eaa0353d41',
    '148': 'f749e12d-5de4-4647-aae2-f7e1c31f6ecb',
    '149': '37a3d6d2-5a85-4a19-bd95-1c208bfd2c5b',
    '150': '3d16be4a-9ff8-4a3e-9c1b-bc63ed848052',
    '151': '452dfeb4-2f74-4eeb-a610-f68087ed07b3',
    '152': 'a09cc78d-7e91-4844-bd3d-3c5db3205fa7',
    '153': '8a34a043-49c3-4b96-8b9e-8553ce4d7177',
    '154': '12ca00ba-8c3a-4251-bed3-a641b5ac634a',
    '155': 'f20ee9ef-74fb-4614-beca-c57223a288c4',
    '156': '2ae27fa7-ef4d-449c-a5d4-5b77a4acb8ca',
    '157': '13302dd4-8f2b-4c7f-aad6-007c94f9a7c6',
    '158': '66125922-8508-40dc-89a5-68c4dd95cf74',
    '159': 'c5c0417d-1631-49d1-a114-98acaaa46c0a',
    '160': '7261c03b-3f0d-447e-a5be-0e3fae83803d',
    '161': 'ae3d6c0c-7c91-44e2-a003-70458cca05c1',
    '162': '54121454-2065-4799-9337-c079db4c7994',
    '163': '71f106c9-4999-48ad-9d0c-be9f6f22df0c',
    '164': '2c956f66-545a-47ea-a202-929565536135',
    '165': 'b98e4282-c875-4ce5-8659-9e25d1fcd723',
    '166': '095b68d6-fb59-4b7a-9c4a-dbb49fe1eca4',
    '167': '9585c06d-2437-424e-9073-97179d4704ad',
    '168': '73c0ac2e-630f-43f1-865f-5b9838f337a2',
    '169': 'c30cbf84-f9a7-4c97-b2d7-8de6f9fb52c7',
    '170': '9e636af1-df08-49f9-9764-309a56faba65',
    '171': 'd7ea0a65-6f71-46cb-8e2b-cc970497afd2',
    '172': '531e8f47-a2df-48a7-81aa-1ebe27ba7787',
    '173': '00f2fdc7-1eb7-4af2-aba0-c0d640d4ab19',
    '174': '720ec980-5e3b-4533-82dc-5163f89ad7e3',
    '175': 'e301fab5-fce5-44c9-b1b9-4e6548e50a2c',
    '176': 'd72c930e-f1e1-43e3-96ba-d93c9b780306',
    '177': 'dd3ca9b2-3da1-4cd5-8e53-034c4cbdf1db',
    '178': '59ee7013-766f-41dc-ba8f-2ea1c89a15ba',
    '179': '26b4beb1-977b-494e-8f92-15a40a02a432',
    '180': '8836f525-5559-40ed-9923-b668bbd553be',
    '181': '2a8158ff-f52c-42df-bf73-bee76eacb7f6',
    '182': 'f1d8da3c-0a71-44cc-ac96-1d16a811f66c',
    '183': '5e20f187-05b6-48cc-a6e0-4c2af8a48970',
    '184': '8154f033-37da-46e4-b97d-f534ac89447d',
    '185': 'e84213a9-8fa9-40be-9696-364a5bac428a',
    '186': 'b445c3f7-a504-4e41-b38b-5ab6b89834f1',
    '187': '765d0b5d-6a91-42dd-9808-8a1675a3ea7a',
    '188': 'ae595f91-1f73-44be-83af-f4691701c6f5',
    '189': '4f2087d3-def4-406b-9f1f-8affd3867b6c',
    '190': '56e4b9c6-35a9-4770-b0f2-ba47b3078d14',
    '191': '3d50b98e-5def-441b-8efb-587888540af4',
    '192': 'f81b1420-0798-4da2-9bc9-4a8e78116c7e',
    '193': 'e192e470-a7b9-49c1-a67e-87fd64a82539',
    '194': 'd86ab342-a567-4aa4-8ffb-1feb52aaaea8',
    '195': 'c63f26c0-96f8-4ec8-82b3-f04aa1250cf2',
    '196': '180baaa2-f862-4940-a81b-f2b6530a55d0',
    '197': '99726337-7bc1-4060-9995-4ca3756d4e39',
    '198': 'ac4666a5-6179-41c6-8ac1-f7d42e96f2a9',
    '199': 'b9c4d290-f6a5-406e-aa38-43db408f7502',
    '200': 'c68b642e-ffe2-4c1e-be15-a390ea0d7ee0',
    '201': '447b1a73-ce0d-4f95-bae5-3743d8fcdcb7',
    '202': '10f8e607-7bad-4f73-9e7e-d0c1f95fa66c',
    '203': '4ec63359-967f-40ad-bf34-62ab5dc77848',
    '204': '9eb8af03-0389-40ac-b65c-e7d6a1ffa0d9',
    '205': 'de9498f1-00a4-4c15-8938-9809733ce410',
    '206': 'b7d35519-5981-4aaf-b9cf-a6715c75921a',
    '207': 'faa72c5e-85ac-42b6-b9e3-d3ff1a890ec9',
    '208': 'd0372c5c-2897-402c-8b26-5d40cfa206cf',
    '209': '184d567a-1f0e-4ce8-8409-d5833e472045',
    '210': '0a2b1a6c-07b9-4a9c-892d-0b7eb678f546',
    '211': '90a5c925-257f-4238-b51e-3998b52029a3',
    '212': '386cfccc-435c-46de-bfcb-cadf73dd3e68',
    '213': '5c670288-b0e6-4eff-8a60-823a3d334268',
    '214': '17591bc9-6702-4751-ae78-e2c3e59c8331',
    '215': 'e62cd729-83d4-47c6-8734-219ea3133ffd',
    '216': 'f36e0557-ec55-408e-82bd-074777404aba',
    '217': '11a87b77-1983-4f5c-b37f-8705151e8232',
    '218': '52c7bc23-4a5a-484f-ad55-846b1948b331',
    '219': 'd89f90e0-7263-4674-9306-726c7e7420a4',
    '220': '30f8bd67-d9e9-4f07-9be9-923f9605d6d3',
    '221': '80211795-33b6-4d41-bbcd-992b5c153e85',
    '222': 'c119852e-85a3-482c-9799-5da30c62f1d1',
    '223': '8a7b07b4-9045-4cc8-b3e0-d2e586683233',
    '224': '9edb7c9c-74fb-4415-95a2-5e0e055b6658',
    '225': '5e0e9e66-af10-420f-bade-99aa25412532',
    '226': '7be9f9a4-2a0c-4d41-84a3-d1531af51f77',
    '227': 'bdb836ee-4445-4b9e-8637-52f87ef8a9c8',
    '228': 'd73db54b-2255-4fd2-8c0d-5de5c12f9002',
    '229': '2bc1da1c-de69-4b33-9030-252802af352b',
    '230': '436f8e8b-bdfb-432d-b663-42bb31135a91',
    '231': '68c66b69-f051-48b9-b278-3cdc3a1940ad',
    '232': 'b2beeb23-eb82-4c95-8550-89c97e2172c8',
    '233': '84b78381-7986-471f-a372-8e6b1fc868ce',
    '234': 'a66599bf-7e53-4655-ba22-b6cef1ddfc6f',
    '235': '821e1976-8c7d-42d1-b216-cfacad1e0d97',
    '236': '9cde469c-eee4-4144-b250-da517d91087b',
    '237': '8c671e18-1dd1-439a-b44a-a48f21626a68',
    '238': 'dfc8908f-335c-4439-bd12-33e1a3afdb5b',
    '239': 'df391617-3619-46e6-a8c3-6d3a0faaaf92',
    '240': '61aacbbf-7aec-4df1-b6af-32739f97e131',
    '241': '8ebb82be-3713-41dc-8441-5cd81e31e7f7',
    '242': '495d2d5b-fd9e-4eff-8db6-c8f81972bd4d',
    '243': '185d129b-ee60-4f50-a70b-cac687cd8ddd',
    '244': 'f6f756ed-8974-4679-a2d7-f18d3c49ba05',
    '245': '1df22802-5f7f-43e4-a29f-6cba05e2c60c',
    '246': '44aa759c-870a-4dc3-923d-52418c556d00',
    '247': 'be173f76-88c5-48e0-840e-1dd895ebfa58',
    '248': 'b83dfe37-cf8c-4d1a-9185-3d9fd21c2d86',
    '249': 'cf7b3017-05ac-4c42-9910-1468371b8bd6',
    '250': 'dda8a9d8-50f2-4ad7-9215-06b190504d56',
    '251': 'bc6aebb9-08ca-4813-9f16-691cf76d07c9',
    '252': '04ede7bc-7ab9-4901-acac-4f505365fb13',
    '253': 'e7fdf720-8c93-4581-a5b0-640a64109729',
    '254': 'ea0e9a3a-e098-4082-bb03-f32d5c13cf2a',
    '255': '7b6af955-c657-4750-90bf-4bad8714ffb8',
    '256': '33030f34-8aeb-4ded-ad86-15d79c1dff2c',
    '257': '7e518d62-22dd-4ec0-95ea-5a6cc02ea001',
    '258': '16ef24f5-10a7-4354-9da9-635f9609c112',
    '259': 'b71f1b00-e344-430f-9761-189c1e4a03aa',
    '260': '2b2a40eb-21f1-423b-ac90-0592b4c53a9f',
    '261': '3e23b8ac-9b59-40fb-8603-467e5bb82fd2',
    '262': 'c6615e4a-c03a-491b-8570-dc1e37144727',
    '263': 'bf978ee3-6f70-41cc-9b35-aaf0e1f8652b',
    '264': 'dd0c6f6a-a8aa-43e3-a34e-757dbdf7f30a',
    '265': '79ee313d-9569-432a-9d1a-b59191c74af7',
    '266': '51d26d53-173b-4ebf-86df-b3965ba17c72',
    '267': 'dfadb356-b2b6-4e11-914d-e114da1e65af',
    '268': 'c5c595a1-68ae-427e-b3d9-963f6d12be90',
    '269': 'c235e801-7103-4a5b-8166-f21055608940',
    '270': 'a1d9b3ed-21be-4b6f-8780-137499fec2b2',
    '271': '82ec5abd-f4c8-4120-88f1-735061c30646',
    '272': '76611fb2-cd13-46bc-9590-20f11fe75354',
    '273': 'a553eeaa-a796-4ae9-ac70-71dc4729eba8',
    '274': '52a1a446-d71a-4bb0-9767-a8346f0e10a0',
    '275': 'de1a2313-c263-4c11-81a4-ee5f4d95cf65',
    '276': 'cb7f27c9-de06-4551-a395-2ca9570d47c6',
    '277': '63e10cf7-9c30-4373-a49e-ccc3b141fcbd',
    '278': '88564581-5279-4edf-baa1-53baa0507ac5',
    '279': '66497a67-5bde-4a78-94a4-c6d4467a351e',
    '280': 'd1d04cf9-c419-444b-932f-dfdb1cfacfa1',
    '281': '8ffc707b-9fcd-4eb4-990b-643a104c0ef0',
    '282': '71ed1956-cf2f-42a4-8782-82071e114b3f',
    '283': 'cee1d7c3-0b91-4d45-8b51-9500c0e5e924',
    '284': 'ed1259f8-9e46-47cd-b8e4-8046217f140e',
    '285': '42bafc14-73f1-45f9-aa19-dd8644c4f65d',
    '286': 'dcb6a75c-b60c-46e2-a165-a21e88c964ad',
    '287': '96d87201-6f91-430a-8ecb-d4c6909bf0cf',
    '288': 'f97daf86-0fb9-457a-99de-9d3f0743aef0',
    '289': '97c32e5f-4c87-4111-9b91-940906248960',
    '290': '76c290b5-1424-410d-bfee-3f993303f1db',
    '291': '9704c7c0-7672-4458-aa80-3db6dec43aa1',
    '292': 'b534b133-50d9-4461-98d5-124e24d7d12a',
    '293': '518587f8-3d96-42af-8168-5dc467961df3',
    '294': '29249e81-bcf5-4078-bac4-b747bec4f3d7',
    '295': 'd06a85ec-3f8b-40ab-af0e-6ea3bbbf2759',
    '296': '5af468c3-3c75-4d3d-a906-c8de8aa3d66e',
    '297': '3a9c85cd-5993-49de-aab0-2a3af27cff01',
    '298': '76fd748b-28cb-4e1e-a842-fd09885794b2',
    '299': '3d60c08b-97e4-49c0-a275-3507bf25d66e',
    '300': 'd15549ce-e452-4c61-8abf-0611907e3e6c',
    '301': '573088d6-6791-485b-b0c6-c97fd51b85e2',
    '302': 'a7fca64c-9224-490a-82d7-8d80cbf6d8a2',
    '303': 'b37a91fd-6cb5-49a0-ba7e-93a624abd9ad',
    '304': 'b7bef9ee-bee3-4944-ae84-1ac25b88c3b9',
    '305': '950ad950-1feb-4069-85f4-98132e2d6ae9',
    '306': 'a5e9b599-a42a-4d1e-bd65-0fb6af85a92b',
    '307': 'f38a9315-bea0-40da-a836-b4201abd5f8c',
    '308': 'afb9bc06-8347-43f5-8389-b466c55fa99d',
    '309': 'e61d6496-c3fb-4d1c-bf36-2891cd8ccd5b',
    '310': '35f57180-4701-4d03-8d9e-bc9ab16c92db',
    '311': 'a7d9fb05-80d9-4bba-a5f0-6eb5ea4a7a56',
    '312': '62d40d24-438e-4d27-900b-03e68345c506',
    '313': '28f25095-dafb-4008-9957-28f41e2ec409',
    '314': 'd8370817-bb7a-44dc-8f04-27870a255d8b',
    '315': 'fc96cbda-213d-4a5c-845d-8bebe1b0ea6a',
    '316': 'fba891d0-8327-45c9-a1b0-59cb221e0c80',
    '317': '62ad1132-157a-4ac8-9f61-9bb96173af07',
    '318': 'd616d020-6e37-4796-8b7f-34cdc910f59d',
    '319': '1d9c6177-7374-4047-a4c1-495af2b53c0a',
    '320': '779f4a20-fdeb-4918-ae58-ae74945c95a8',
    '321': '82b2a0a0-33a8-4dd3-a08e-6759d3b60db2',
    '322': '348ae707-9f9c-42f0-9841-eed931ded247',
    '323': '1ee0811f-4f29-41ac-a2ae-bc249cd3e26e',
    '324': 'c1e87568-fa41-49e4-9b6a-969dae0c9913',
    '325': '5ba3ea4c-988d-4d98-8d69-79213e8c7b2f',
    '326': '701215ab-182b-49bf-9188-3de344ea3e47',
    '327': '6ff2c13f-5f81-4f81-9c56-2fcfe7b4ca53',
    '328': 'e1a821d3-64ac-452f-ba37-bbd331417f12',
    '329': '730d7e32-7a3b-4cfd-b3bd-aa7de80e8d10',
    '330': '4fc073fc-7cf8-45e5-bd67-78798e3437be',
    '331': '6351e349-b02e-4ca5-9e2a-f0a30dbf7b5b',
    '332': 'e98b78ce-14d8-4825-a7f4-26e9b8029141',
    '333': 'f68164c2-dfb3-4a08-9ee0-6cdddd632097',
    '334': 'b9d33389-b5f8-4a6f-96fb-8262f32f5541',
    '335': '2abb4f77-3be7-4266-a662-69012e8b91d4',
    '336': '47061e03-4b39-492c-9f8a-46bf6d618ebc',
    '337': '16de248f-70b8-4023-893b-3d33c587424c',
    '338': '446efb6a-c909-4f92-9065-733b0553eef3',
    '339': '1af71c25-2e4c-4fc6-89ba-2965f04d59a1',
    '340': '8e097710-3f91-4e01-a63c-7a760b789c34',
    '341': '34993a9e-1de5-431f-bcb7-241a974b1cd4',
    '342': '2139b2b7-a9e1-4426-ad90-089498eb4361',
    '343': '0ba24170-5b21-4217-9933-e0c03609eceb',
    '344': 'b74577be-2a4e-467d-806d-45abc7723487',
    '345': '0443f186-cf04-4421-bb79-f2fb6094ebec',
    '346': '815b0069-63a2-49cc-87f8-8c9652116423',
    '347': 'c51bb15e-9aa6-4043-9131-577047eb40f7',
    '348': '795b0697-f70f-4ac8-80fd-fcd3c96beea2',
    '349': 'f48ece4c-01ba-4cb0-976e-6fbbd53fbf54',
    '350': 'c769a9f9-f996-40b0-baf0-c72f3afaefa1',
    '351': 'fc3da2ee-f516-4788-ac60-aeeeb0fce32b',
    '352': '91cf45b0-b3ba-4991-818a-deebb04389d5',
    '353': '8c9c6fc0-8a8b-49f2-8ed9-8a68a39f66fc',
    '354': '5fbb4a62-9270-47bf-942e-3bb9e85bc7e0',
    '355': '1984933a-5215-4470-a79e-ffe34b6183dd',
    '356': '75dd5017-18de-48f8-995d-f0f174507f5a',
    '357': '882ae4bf-df8c-46d5-946d-0378211e1a89',
    '358': '0d0d5f23-e929-4ba1-be40-279ea843ca87',
    '359': 'edd3510b-b14b-4c78-8722-220e98e7f70b',
    '360': '715a88d8-6af3-466b-a0ff-2ec20a740a66',
    '361': '9abb48dd-da88-443d-b078-06ba812bab6a',
    '362': '5e632b57-4773-4ac4-8937-f4d55f63527f',
    '363': '265cfb4e-f667-435e-bcac-e80b143eaa6f',
    '364': '4a25712d-f103-481f-8ab1-70181dc089af',
    '365': '2debba72-9b33-46c4-8ddf-8e106f231e4d',
    '366': '37304141-ff21-4866-a1b2-793dfe6b4f1e',
    '367': '988caec9-3e08-43ed-999a-c2db5c3a52c7',
    '368': 'a751ad15-2f9e-44dd-9485-6e403f991a68',
    '369': '0933e518-887d-4b9b-ad2a-487a4dcaa2fa',
    '370': '4861bae4-6444-44bc-98c3-1431fcc3123b',
    '371': 'f820647f-f8a5-452c-8cff-5d7cd1d04712',
    '372': 'bf21af1e-47ac-4e5c-8fb7-047329472ef1',
    '373': 'bed22aa4-b56a-4fbc-932b-64088ea11a8c',
    '374': '145fe69a-9a59-4ee9-8c45-0d92a8071c3d',
    '375': '82bc2597-1f75-4c31-b331-28c4e7598e9d',
    '376': '29f350b1-affb-4abc-a2e8-fbb1a0b53fa9',
    '377': '0bb4b08d-1405-4003-8b35-67c9b6b2f5ea',
    '378': 'fc7d355b-d451-40f3-9740-18b6879a97c8',
    '379': 'c238a25a-54b8-4ce1-b971-b101c410bbbd',
    '380': '93aae508-c488-4fdc-ba5e-a0a2d6b22309',
    '381': '06bc1a1b-1eaa-4fca-9685-d118e712c45c',
    '382': '771ea9e7-c393-4c58-b7dc-2f764ae9b570',
    '383': '6e34caca-0c8b-4d58-9803-3bb1e3171a9a',
    '384': '608ee949-2672-46ec-af22-f60ecbc07ce1',
    '385': 'e2cfd663-b49b-4a6a-8a75-7e6108e45b6f',
    '386': '8bda735a-0779-4663-9e1f-4f695f130391',
    '387': '5f3ced38-e5f0-47cb-938f-09fb90d03ed5',
    '388': 'e2aad7dd-4669-4600-8dd4-60428d3ef859',
    '389': 'a218cce1-cf2a-4c3f-ad01-3e9645435afe',
    '390': 'd6124eba-c03d-4298-b67a-aaead64ed487',
    '391': '0dd647f3-89bb-4792-93a6-eb4922fea5ac',
    '392': 'b022fedf-f522-4c6d-996f-b773b07974c5',
    '393': '29cff956-e279-4e29-a740-e7f844d57558',
    '394': '00d5dde1-f4fc-4e64-8431-971a1d81831d',
    '395': '6c7f237b-5572-4e74-bd6d-7a036b1244bb',
    '396': 'cb67bf1d-473f-4d97-94a0-544f6861c2f6',
    '397': 'dd722afd-ad43-49a1-b357-0e0c9069a8da',
    '398': '3151be8e-3f95-4621-8f32-90f69ea5ae52',
    '399': 'cb2afaf7-d60b-47e5-bddb-b0f5e3d5877b',
    '400': '751f730f-db79-4dda-8b84-90b6e3f3e9f3',
    '401': '5ff8920b-d1fb-409a-ba50-f6244e11f4cc',
    '402': '66194f88-2802-4c18-9382-bb09dbb1ddb5',
    '403': 'f1b8c8d7-4ffd-4951-b3c7-d0cbf5a3da19',
    '404': 'c1948bf8-e1d1-4542-982c-02f9f86bafc0',
    '405': 'eedb2e05-2977-41e5-b56c-dc5868e8d152',
    '406': '4b4b3221-21ef-447e-b5d3-29b1e38cc0b7',
    '407': 'f9b6bb8b-d2eb-4690-9abd-410a974e5863',
    '408': 'e897d98c-7391-4287-a738-cf063847be82',
    '409': '1db14660-7a03-436e-999c-fd7d4fde4935',
    '410': '3a6d3711-1380-43e7-a49e-d998bd5e8df9',
    '411': '9ce5f719-0998-41b4-bf6d-e23e231c9ebc',
    '412': '0a215ab3-333e-4c97-aee4-cd3810ba83d1',
    '413': '4e67b67f-2e1b-4a3a-8163-bf88f7fd9159',
    '414': '7a591b77-1951-4c2c-b791-5b91840c2af6',
    '415': '90ed3d38-a30c-4a05-bb7f-d3234d3da719',
    '416': '9b566a92-4f8a-4d84-844e-75de9ad3a7d7',
    '417': 'fa0a2dcc-516f-48db-88ac-efc28b08279a',
    '418': '6157a4af-feff-4293-b7fc-b3a5e8a170bb',
    '419': '960d3777-a4ea-4a60-b673-2eae511a0609',
    '420': '7626aee6-c856-40cf-a732-9c14f1703ce6',
    '421': '3e8d9cbc-5670-4012-a5dc-62dcb7dc1976',
    '422': 'a85639a5-77c9-4206-ae9d-c2e9dcb7a3ed',
    '423': '9cb87388-a4c7-4bbd-9ceb-4a2a2fb73a14',
    '424': 'e88649bd-7b24-4af6-a7ac-5dc143e8401c',
    '425': '52d037f3-ccc7-4a90-84c8-cc667521b476',
    '426': '11141869-0e61-433c-916e-9b03ec2fcb1d',
    '427': '8041acc5-ec39-4094-81f3-de168001904f',
    '428': '28863c07-0ba7-4cd0-baaf-bab9a40d3784',
    '429': 'c8356c72-90e5-499d-8dcc-8beb1eec9ad1',
    '430': 'b0818944-e080-4696-a5e8-d9c86f5decc2',
    '431': 'c8cb3cc5-52f0-4d9c-9185-7866556095c1',
    '432': '3f90e774-34d1-4844-970a-156320704bf8',
    '433': '7246587f-b6df-4aa2-aaaa-33a348f292b1',
    '434': 'd2e15403-f269-47a6-8186-d93c8952d5fc',
    '435': 'bfbc67d5-1542-4793-b7cc-9a45b187a391',
    '436': 'f8b1c56d-620c-4a99-9dcb-5738e12b0878',
    '437': '52653334-533b-4b2a-a0db-0fbde44e8f55',
    '438': 'a80e9fe1-6cc8-4a6f-a878-96edf6cc0062',
    '439': '8912aa50-3531-4b90-98e4-6369dcb6d7ce',
    '440': '411e9c6c-1bb7-40c5-ad66-044cc481a12c',
    '441': 'b7c6d4b1-e008-4c78-8c15-27582e8fd782',
    '442': '7b72327d-d477-4c53-ac5b-d614f39a345c',
    '443': '5a4c359c-741f-4166-8eb6-33648338093a',
    '444': 'bd2a7bc3-baf2-49af-a94d-c709787ab8de',
    '445': '13fb9968-9794-491b-914b-a2948bd137ac',
    '446': 'cc6ecdf1-16a5-4454-aaee-5308d0260e25',
    '447': 'c1b67761-5ec1-494a-b288-343fbfcedb04',
    '448': '8cf07d69-305c-4916-bfea-fbfc96dc719d',
    '449': '43274bc1-73be-4680-89c1-976c641ab76e',
    '450': '1b1da59d-d2a3-46b1-98bf-d1ee9bfe5c42',
    '451': 'bd82cd2d-1774-4ff8-96cd-22d03e5966df',
    '452': '3fd3adf8-d909-4d95-b6ec-dcc085b9d249',
    '453': '0f2c2756-8f03-4db5-9aca-a30468bbd699',
    '454': 'e3894327-5ce3-4de9-a817-8c4daa7c6ec9',
    '455': 'c58b2c82-1a1d-44fa-90be-9e5a424f238b',
    '456': 'b3143551-e6b3-433b-92a0-3c6cbe56b078',
}
# No fixed completion-count hint: a later live menu may add chapters.
_METADATA = {}
_TITLE_AUDIT_FAILED = False
DEFAULT_START_URL = 'https://mangadex.org/chapter/61f1d297-3b3b-4d83-87a2-9ab68b709d35'
ALLOWED_HOSTS = ('mangadex.org',)
BRIDGE_IMAGE_HOSTS = ('api.mangadex.org', 'uploads.mangadex.org')
EXTENSION_MATCHES = ('https://mangadex.org/chapter/*',)
TITLE_SELECTORS = ('meta[property="og:title"]',)
CHAPTER_LIST_SELECTORS = ()
NEXT_NAV_SELECTORS = ()
PREV_NAV_SELECTORS = ()
CHAPTER_MENU_SELECTORS = ()
READER_SELECTORS = ('.md--reader-pages',)
PAGE_TOTAL_SELECTORS = ('.md--reader-pages img',)
IMAGE_ATTRIBUTES = ('src', 'data-src', 'data-original')
IMAGE_PLACEHOLDER_URL_MARKERS = ()
SOURCE_CONFIRMED_MISSING_PANELS = {}

_API = 'https://api.mangadex.org'
_UUID = re.compile(r'^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$', re.I)
_PANEL_FILE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,240}\.(?:png|jpe?g|webp|avif|gif)$', re.I)
_SESSION = requests.Session()
_SESSION.headers.update({'Accept':'application/json', 'User-Agent':'ComicArchiver/1.5.17 (+MangaDex public API; image integrity verification)'})
_LOCK = threading.RLock()
_LAST_API_REQUEST = 0.0
_SEED = None
_FEED = None
_AT_HOME = {}
_DOM = {}
_IMAGE_URLS = set()
_ALT_NAMES = {}  # chapter UUID -> dataSaver filename mapping onto canonical data order
# COMICARCHIVER_AUTH_BLOB_TRANSFER_20261122 provider-specific exact decoded image references.
# This is cache metadata only, never a substitute for actual image bytes.
_DECODED_BLOBS = {}  # chapter UUID -> {verified canonical image filename: blob URL}



def _uuid_from_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.netloc != 'mangadex.org' or parsed.query or parsed.fragment):
        raise ValueError('MangaDex chapter must use https://mangadex.org')
    pieces = parsed.path.strip('/').split('/')
    if len(pieces) not in (2,3) or pieces[0] != 'chapter' or not _UUID.fullmatch(pieces[1]):
        raise ValueError('MangaDex chapter URL must contain a verified UUID: '+url)
    if len(pieces) == 3 and (not pieces[2].isdigit() or int(pieces[2]) < 1):
        raise ValueError('Invalid MangaDex page number')
    return pieces[1].lower()


def _api_json(path, *, params=None):
    """Bounded public API access. Fail closed on 403, 429 or incomplete feeds."""
    global _LAST_API_REQUEST
    if not (path.startswith('/') and '://' not in path and '..' not in path):
        raise ValueError('Unsafe MangaDex API path')
    with _LOCK:
        delay = max(0, .37 - (time.monotonic()-_LAST_API_REQUEST))
        if delay: time.sleep(delay)
        _LAST_API_REQUEST = time.monotonic()
        response = _SESSION.get(_API+path,params=params,timeout=(10,35),allow_redirects=False)
    if response.status_code == 429:
        raise RuntimeError('MangaDex API rate-limited (429). Stop and retry after its Retry-After interval; no chapters skipped.')
    if response.status_code in (401,403):
        raise RuntimeError(f'MangaDex API access denied ({response.status_code}); not bypassing site protection')
    if response.status_code != 200:
        raise RuntimeError(f'MangaDex API {path} returned {response.status_code}; chapter discovery not complete')
    data = response.json()
    if not isinstance(data,dict) or data.get('result') != 'ok':
        raise RuntimeError('MangaDex API returned an incomplete/invalid result')
    return data


def _number(value):
    value = str(value) if value is not None else ''
    if not re.fullmatch(r'\d+(?:\.\d+)?', value):
        raise RuntimeError('Invalid native MangaDex chapter number: '+value[:80])
    return format(Decimal(value).normalize(), 'f')


def _validate_metadata(data, uid, expected=None):
    if not isinstance(data, dict) or data.get('id') != uid or data.get('type') != 'chapter':
        raise RuntimeError('MangaDex chapter metadata identity mismatch')
    attrs = data.get('attributes') or {}
    rel = data.get('relationships') or []
    manga = {r.get('id') for r in rel if r.get('type') == 'manga'}
    groups = {r.get('id') for r in rel if r.get('type') == 'scanlation_group'}
    if expected is None:
        expected = next((n for n, ident in _CAPTURED_CHAPTERS.items() if ident == uid), None)
    if (manga != {_MANGA} or attrs.get('translatedLanguage') != 'en' or
        (expected is not None and _number(attrs.get('chapter')) != expected) or
        attrs.get('externalUrl') or attrs.get('isUnavailable') or
        type(attrs.get('pages')) is not int or attrs['pages'] < 1 or
        (uid == _CAPTURED_CHAPTERS['1'] and _GROUP not in groups)):
        raise RuntimeError('MangaDex chapter identity/availability mismatch: '+uid)
    return data


def _seed_info():
    global _SEED
    with _LOCK:
        if _SEED is None:
            uid = _uuid_from_url(DEFAULT_START_URL)
            data = _validate_metadata(_api_json('/chapter/'+uid)['data'], uid, '1')
            _METADATA[uid] = data
            _SEED = {'manga':_MANGA, 'lang':'en', 'groups':frozenset({_GROUP}), 'seed':uid}
        return _SEED


def _native_catalog(raw_html):
    # The native reader provides chapter UUIDs in li[data-value], not links.
    # Compare a live catalog against the captured minimum; only a full matching
    # list can expand it. An unhydrated menu cannot silently shorten the archive.
    if not raw_html: return dict(_CAPTURED_CHAPTERS)
    soup = BeautifulSoup(raw_html, 'html.parser')
    actual = {}
    for row in soup.select('.reader--menu li[data-value]'):
        uid = str(row.get('data-value') or '')
        m = re.fullmatch(r'Chapter\s+(\d+(?:\.\d+)?)', row.get_text(' ',strip=True), re.I)
        if not m or not _UUID.fullmatch(uid): continue
        n = _number(m.group(1))
        if n in actual and actual[n] != uid:
            raise RuntimeError('Conflicting native MangaDex chapter menu entries: '+n)
        actual[n] = uid
    if len(set(actual.values())) != len(actual):
        raise RuntimeError('Duplicate UUID across native chapter numbers')
    for n, uid in actual.items():
        if n in _CAPTURED_CHAPTERS and uid != _CAPTURED_CHAPTERS[n]:
            raise RuntimeError('Native MangaDex chapter edition changed at '+n+'; refusing to silently substitute a different upload')
    if set(_CAPTURED_CHAPTERS).issubset(actual):
        return dict(sorted(actual.items(),key=lambda item:Decimal(item[0])))
    if set(actual)-set(_CAPTURED_CHAPTERS):
        raise RuntimeError('Native chapter list is incomplete while advertising new chapters')
    return dict(_CAPTURED_CHAPTERS)


def _feed_chapters(catalog=None):
    global _FEED
    if catalog is None:
        if _FEED is not None: return _FEED
        catalog = _CAPTURED_CHAPTERS
    with _LOCK:
        if _FEED is not None and tuple(c['id'] for c in _FEED)==tuple(catalog.values()):
            return _FEED
        seed = _seed_info()
        wanted = {uid:n for n,uid in catalog.items()}
        offset=0; total=None; found={}; seen_ids=set()
        while total is None or offset < total:
            result=_api_json('/manga/'+seed['manga']+'/feed',params=[
                ('translatedLanguage[]',seed['lang']),('order[chapter]','asc'),
                ('limit','100'),('offset',str(offset))])
            portion=result.get('data'); value=result.get('total')
            if (not isinstance(portion,list) or type(value) is not int or not 1<=value<=100000 or
                (total is not None and value!=total) or result.get('offset',offset)!=offset or not portion):
                raise RuntimeError('MangaDex feed incomplete or changed during pagination')
            total=value
            for ch in portion:
                uid=str(ch.get('id',''))
                if not _UUID.fullmatch(uid) or uid in seen_ids:
                    raise RuntimeError('Invalid/duplicate MangaDex feed UUID')
                seen_ids.add(uid)
                if uid in wanted:
                    found[uid]=_validate_metadata(ch,uid,wanted[uid])
            offset+=len(portion)
            if offset>total: raise RuntimeError('MangaDex feed exceeded declared total')
        if set(found)!=set(wanted):
            missing=[n for n,uid in catalog.items() if uid not in found]
            raise RuntimeError('MangaDex feed omitted native chapter(s): '+', '.join(missing[:15])+f' ({len(missing)} total)')
        _METADATA.update(found)
        _FEED=tuple(found[u] for u in catalog.values())
        return _FEED


def _chapter_metadata(uid):
    with _LOCK:
        if not _UUID.fullmatch(uid): raise RuntimeError('Invalid MangaDex chapter UUID')
        if uid not in _METADATA:
            # On resume the engine uses already persisted catalog UUIDs. Check
            # each chapter again before trusting its image manifest.
            _METADATA[uid] = _validate_metadata(_api_json('/chapter/'+uid)['data'],uid)
        return _METADATA[uid]


def chapter_identity(anchor, url, label):
    return 'mdx-' + _uuid_from_url(url)


def title_from_html(soup):
    if not soup.find(True) and not soup.get_text(strip=True):
        return _SERIES_TITLE
    reader = soup.select_one('.reader--header-manga')
    if reader:
        link=urlsplit(urljoin('https://mangadex.org/',str(reader.get('href') or '')))
        if link.scheme != 'https' or link.netloc != 'mangadex.org' or link.path.split('/')[1:3] != ['title',_MANGA]:
            raise RuntimeError('MangaDex live reader series identity mismatch')
        return _SERIES_TITLE
    # Initial/SSR HTML can use the romanized title rather than the English title.
    title=soup.title.get_text(' ',strip=True) if soup.title else ''
    match=re.search(r'\bChapter\s+[^|]+\s+-\s+(.+?)\s+-\s+MangaDex\s*$',title,re.I)
    if match and match.group(1).strip()==_SERIES_TITLE:
        return _SERIES_TITLE
    og=soup.select_one('meta[property="og:title"]')
    if og and re.fullmatch(r'Wǒ Jiā Lǎopo Láizì Yīqiān Nián Qián - (?:Vol\. [^ ]+ )?Ch\. \d+(?:\.\d+)? - MangaDex',str(og.get('content') or '')):
        return _SERIES_TITLE
    raise RuntimeError('MangaDex page did not provide the expected series title')


def chapter_title_from_anchor(anchor,fallback): return fallback

def chapter_title_from_html(soup,fallback): return fallback

def title_catalog_url(saved_url): return saved_url or DEFAULT_START_URL

def accept_catalog_title(chapter_id,title):
    return str(chapter_id) in {'mdx-'+ch['id'] for ch in (_FEED or ())} and bool(str(title).strip())

def chapter_title_is_generic(label,chapter_id):return False


def _chapter_label(ch):
    at=ch['attributes']; number=at.get('chapter'); volume=at.get('volume'); title=str(at.get('title') or '').strip()
    label=('Vol. '+str(volume)+' ' if volume else '')+('Ch. '+str(number) if number is not None and str(number).strip() else 'Special')
    return label+(' - '+title if title else '')


def custom_chapters(raw_html,page_url,chapter_class):
    catalog = _native_catalog(raw_html)
    if _uuid_from_url(page_url) not in catalog.values():
        raise RuntimeError('Source URL outside verified MangaDex series')
    result=[]
    for ch in _feed_chapters(catalog if _FEED is None or len(catalog)>len(_CAPTURED_CHAPTERS) else None):
        result.append(chapter_class('mdx-'+ch['id'], _chapter_label(ch),
                                    'https://mangadex.org/chapter/'+ch['id']))
    return result


class _NativeChapter:
    def __init__(self,chapter_id,label,url):
        self.chapter_id,self.label,self.url=chapter_id,label,url


def native_chapter_titles_from_catalog(raw_html,page_url):
    global _TITLE_AUDIT_FAILED
    _TITLE_AUDIT_FAILED = False
    try:
        return {ch.chapter_id:ch.label for ch in custom_chapters(raw_html,page_url,_NativeChapter)}
    except (RuntimeError, requests.RequestException, ValueError) as exc:
        _TITLE_AUDIT_FAILED = True
        print('MangaDex native title audit unavailable: '+str(exc), flush=True)
        return {}


def captured_native_chapter_titles():
    # Reuse verified API titles, or perform one public feed lookup if HTML
    # was unavailable. Do not replay a failed/denied API audit.
    if _TITLE_AUDIT_FAILED: return {}
    try:
        return {'mdx-'+ch['id']: _chapter_label(ch) for ch in _feed_chapters()}
    except (RuntimeError, requests.RequestException, ValueError) as exc:
        print('MangaDex title audit unavailable: '+str(exc), flush=True)
        return {}


def _at_home(chapter_uuid):
    with _LOCK:
        if chapter_uuid in _AT_HOME: return _AT_HOME[chapter_uuid]
        expected=_chapter_metadata(chapter_uuid)['attributes']['pages']
        data=_api_json('/at-home/server/'+chapter_uuid)
        node=data.get('chapter') or {}; hash_value=str(node.get('hash') or '')
        files=node.get('data')
        base=str(data.get('baseUrl') or '').rstrip('/')
        parsed=urlsplit(base)
        host=parsed.hostname or ''
        if not (parsed.scheme=='https' and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and parsed.port is None and parsed.path in ('','/')
                and (host=='uploads.mangadex.org' or host=='mangadex.org' or host.endswith('.mangadex.network'))):
            raise RuntimeError('Unrecognized/untrusted MangaDex image delivery host: '+host)
        if not re.fullmatch(r'[A-Za-z0-9]{20,128}',hash_value) or not isinstance(files,list) or not files:
            raise RuntimeError('MangaDex chapter image manifest missing hash/page list')
        if any(not isinstance(name,str) or not _PANEL_FILE.fullmatch(name) or '/' in name or '..' in name for name in files):
            raise RuntimeError('MangaDex returned an unsafe image filename')
        if len(files)!=expected: raise RuntimeError('MangaDex @Home page count differs from native chapter metadata')
        if len(set(files))!=len(files):raise RuntimeError('Duplicate MangaDex panel names; refusing reorder')
        saver=node.get('dataSaver') or []
        if saver and (not isinstance(saver,list) or len(saver)!=len(files) or
                      len(set(saver))!=len(saver) or
                      any(not isinstance(n,str) or not _PANEL_FILE.fullmatch(n) for n in saver)):
            raise RuntimeError('MangaDex saver-quality panel order is invalid')
        indices={name:i for i,name in enumerate(files)}
        for i,name in enumerate(saver):
            if name in indices and indices[name]!=i:
                raise RuntimeError('Conflicting MangaDex data/saver panel identity')
            indices[name]=i
        _ALT_NAMES[chapter_uuid]=indices
        urls=tuple(base+'/data/'+hash_value+'/'+name for name in files)
        _AT_HOME[chapter_uuid]=(tuple(files),urls)
        _IMAGE_URLS.update(urls)
        return _AT_HOME[chapter_uuid]


def _http_image_get(url,headers=None,timeout=45000):
    # Exact identity allowlist comes from this chapter's @Home manifest, never
    # from guessed URLs or a broad CDN regex. No source browser cookies sent.
    with _LOCK:
        if url not in _IMAGE_URLS:
            raise RuntimeError('Image URL not present in the verified MangaDex chapter manifest')
    session=requests.Session()
    response=session.get(url,headers={'Accept':'image/*','Referer':'https://mangadex.org/'},
                         timeout=(10,max(10,float(timeout)/1000)),allow_redirects=False)
    from reusable.browser_bridge import BrowserResponse
    return BrowserResponse(url,response.status_code,dict(response.headers),response.content,'api-at-home')


def after_chapter_visit(page,page_url):
    chapter=_uuid_from_url(page_url)
    _at_home(chapter)
    ctx=getattr(page,'context',None)
    req=getattr(ctx,'request',None)
    if req is None: raise RuntimeError('MangaDex adapter requires a normal browser context')
    _DECODED_BLOBS.pop(chapter,None)
    _DOM.pop(chapter,None)
    def get_exact_image(url,headers=None,timeout=45000):
        # Every requested URL must be an exact member of THIS chapter's @Home
        # manifest. The native DOM filename identifies its decoded blob.
        names,urls=_at_home(chapter)
        if url not in urls:
            raise RuntimeError('Image not in current MangaDex chapter manifest')
        native_name=names[urls.index(url)]
        blob=_DECODED_BLOBS.get(chapter,{}).get(native_name)
        if blob and getattr(ctx,'bridge',None):
            response=ctx.bridge.rpc('read_loaded_blob',{
                'url':blob,'reader_selectors':list(READER_SELECTORS),
                'require_clean_pixels':True},timeout=45)
            if response.get('status')==200 and response.get('base64'):
                import base64
                from reusable.browser_bridge import BrowserResponse
                data=base64.b64decode(response['base64'],validate=True)
                return BrowserResponse(url,200,response.get('headers') or {},data,
                                       response.get('via') or 'decoded-source-tab-blob')
            if response.get('status') != 424:
                # Never retry an access denial or transport error as an alternate path.
                raise RuntimeError('MangaDex decoded-image transfer failed: '+str(response.get('status')))
            # Only a local blob lifetime failure permits the original, declared
            # public @Home request. Explicit HTTP denial remains handled by engine.
        return _http_image_get(url,headers=headers,timeout=timeout)
    req.get=get_exact_image
    # Generic engine still validates every returned byte using Pillow/SHA-256.
    # HTTP fallback is a real provider request and remains request-guarded.
    req.reuses_loaded_page_images=False
    req._mangadex_verified_api=True


def custom_page_snapshot(page):
    chapter=_uuid_from_url(page.url)
    names,urls=_at_home(chapter)
    # The fixed reusable bridge returns its real DOM snapshot for this marker.
    # A native Playwright browser executes the full source-neutral expression.
    info=page.evaluate('''() => { /* MutationObserver */
      const root=document.querySelector('.md--reader-pages');
      const imgs=[...(root?.querySelectorAll('img')||[])].map((im,i)=>({
        key:String(i+1),url:im.currentSrc||im.src||'',
        loaded:!!(im.complete&&im.naturalWidth&&im.naturalHeight),
        width:im.naturalWidth||0,height:im.naturalHeight||0,
        pageY:im.getBoundingClientRect().top+scrollY}));
      const height=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight);
      return {imgs,total:imgs.length,readerCount:imgs.length,unloadedSlots:imgs.filter(x=>!x.loaded).length,
        scrollY:scrollY||0,bottom:Math.max(0,height-innerHeight),height,viewportHeight:innerHeight,revision:0};
    }''')
    if not isinstance(info,dict): raise RuntimeError('MangaDex browser returned no snapshot')
    raw_imgs=info.get('imgs') or []
    # Match real source URL to the DOM filename, never infer the filename
    # from a recycled DOM index. Re-read HTML even when mount count stays equal.
    soup=BeautifulSoup(page.content(),'html.parser')
    root=soup.select_one('.md--reader-pages')
    indices=_ALT_NAMES.get(chapter) or {n:i for i,n in enumerate(names)}
    by_src={}; native_positions=[]
    if root:
        for im in root.select('img'):
            src=str(im.get('src') or '').strip(); alt=str(im.get('alt') or '').strip()
            if not src or src.startswith('data:'): continue
            if alt not in indices:
                raise RuntimeError('MangaDex rendered filename absent from verified @Home manifest: '+alt[:100])
            pos=indices[alt]
            if src in by_src or pos in native_positions:
                raise RuntimeError('Duplicate MangaDex panel identity')
            by_src[src]=pos; native_positions.append(pos)
    if native_positions!=sorted(native_positions):
        raise RuntimeError('MangaDex DOM image order differs from verified @Home manifest')
    by_name={}; matched=[]; decoded={}
    for node in raw_imgs:
        src=str(node.get('url') or '')
        if src not in by_src or not node.get('loaded'): continue
        pos=by_src[src]
        if pos in matched: raise RuntimeError('Duplicate MangaDex snapshot panel')
        matched.append(pos); by_name[names[pos]]=node
        if (src.startswith('blob:https://mangadex.org/') and
            int(node.get('width') or 0)>0 and int(node.get('height') or 0)>0):
            decoded[names[pos]]=src
    if matched!=sorted(matched):
        raise RuntimeError('MangaDex snapshot image order differs from verified @Home manifest')
    _DECODED_BLOBS[chapter]=decoded
    if matched:
        _DOM[chapter]=True
    if not _DOM.get(chapter):
        return {**info,'imgs':[],'total':len(names),'readerCount':len(raw_imgs),
                'missingSlots':len(names),'unloadedSlots':len(names)}
    if not root:
        raise RuntimeError('Verified MangaDex reader disappeared during acquisition')
    # MangaDex's API supplies the complete authoritative ORIGINAL file list and
    # reading order. A SPA may virtualize or lazily mount only a few images in
    # the DOM. That is not evidence those missing DOM nodes lack image bytes.
    # Every HTTP image is verified with Pillow/SHA-256 by the generic engine.
    entries=[]
    for i,(name,url) in enumerate(zip(names,urls),1):
        node=by_name.get(name)
        entries.append({'key':str(i),'url':url,'loaded':True,
                        'width':node.get('width',0) if node else 0,
                        'height':node.get('height',0) if node else 0,
                        'pageY':node.get('pageY',0) if node else 0})
    return {**info,'imgs':entries,'total':len(entries),'readerCount':len(raw_imgs),
            'missingSlots':0,'unloadedSlots':0}
