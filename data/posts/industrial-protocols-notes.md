# 工业通信协议实战笔记：OPC UA、Modbus与Profinet

做产线智能化，绕不开设备通信。设备不联网，数据采不上来，一切都是空谈。

## 三大协议对比

| 特性 | Modbus | Profinet | OPC UA |
|------|--------|----------|--------|
| 层级 | 应用层 | 实时以太网 | 应用层 |
| 实时性 | 毫秒级 | 微秒级 | 百毫秒级 |
| 配置复杂度 | 低 | 中 | 高 |
| 生态 | 极广泛 | 欧系设备为主 | 快速增长 |
| 适合场景 | 简单设备 | 运动控制 | 数据采集/MES |

## Modbus：简单粗暴，但好用

Modbus 是最老牌的工业协议，简单到不能再简单——就是读写寄存器。

### Modbus TCP 通信

```python
from pymodbus.client import ModbusTcpClient

client = ModbusTcpClient('192.168.1.100', port=502)
client.connect()

# 读保持寄存器（比如温度传感器）
result = client.read_holding_registers(address=0, count=2, slave_id=1)
temperature = (result.registers[0] << 16 | result.registers[1]) / 10.0
print(f"温度: {temperature}°C")

# 写线圈（比如控制继电器）
client.write_coil(address=10, value=True, slave_id=1)

client.close()
```

### 实战踩坑

1. **字节序问题**：不同设备的高低字顺序可能不同，有的先高后低，有的先低后高。读出来的值不对，第一时间查字节序。

```python
def decode_int32(registers, byte_order='big'):
    """处理不同字节序的32位整数解码"""
    if byte_order == 'big':
        return (registers[0] << 16) | registers[1]
    else:
        return (registers[1] << 16) | registers[0]
```

2. **超时设置**：产线上设备多，轮询周期要合理。太快会冲爆设备，太慢数据不实时。一般 200ms~1s。

3. **浮点数**：Modbus只支持16位寄存器，32位浮点数要占两个寄存器，而且字节序同样是个坑。

## Profinet：实时性之王

Profinet 是西门子主推的实时以太网协议，在运动控制场景几乎不可替代。

### 为什么需要 Profinet

```
普通以太网: ~10ms 延迟，抖动大 → 不能做运动控制
Profinet IRT: <1ms 周期，抖动 <1μs → 可以做伺服控制
```

### 实战使用

Profinet 的配置主要在 PLC 侧（TIA Portal），Python 端一般通过 snap7 之类库间接交互：

```python
import snap7

plc = snap7.client.Client()
plc.connect('192.168.0.1', rack=0, slot=1)

# 读取 DB 块数据
data = plc.db_get(db_number=1)
# 解析具体变量需要知道偏移量和数据类型

plc.disconnect()
```

### 实战踩坑

1. **GSDML 文件**：每个 Profinet 设备都有对应的 GSDML 描述文件，版本不匹配会导致设备无法识别
2. **设备名称分配**：Profinet 用名称而不是 IP 寻址，名称分配错误是最常见的问题
3. **RT vs IRT**：如果不需要微秒级实时性，用 RT 就行，IRT 配置复杂得多

## OPC UA：面向未来的选择

OPC UA 是我目前在产线数据采集中**首选的协议**。

### 为什么选 OPC UA

1. **信息模型**：不只是传数据，还带语义（变量名、单位、数据类型、报警阈值）
2. **平台无关**：Windows/Linux/嵌入式都能跑
3. **安全机制**：内置认证、加密、审计
4. **订阅模式**：不用轮询，数据变化自动推送

### Python 实战

```python
from opcua import Client

client = Client("opc.tcp://192.168.1.50:4840")
client.connect()

# 方法一：直接按 NodeId 读取
temp = client.get_node("ns=2;s=Temperature")
value = temp.get_value()
print(f"温度: {value}")

# 方法二：浏览地址空间
root = client.get_root_node()
objects = root.get_children()[0]
for obj in objects.get_children():
    print(obj.get_browse_name())

# 方法三：订阅（推荐！数据变化时回调）
from opcua import Subscription
sub = client.create_subscription(500)  # 500ms 采样
handle = sub.subscribe_data_change(temp)
# 数据变化时自动触发回调

client.disconnect()
```

### 实战踩坑

1. **证书信任**：OPC UA 安全模式需要交换证书，开发阶段可以先用 None 安全模式，上线务必切回 Sign&Encrypt
2. **命名空间**：NodeId 的 ns 值每个服务器不同，不能硬编码，要动态查找
3. **大量数据订阅**：订阅太多节点会拖慢服务器，合理分组和设置采样间隔

## 我的选型建议

```
需要微秒级实时控制？ → Profinet IRT
设备老旧只支持串口/Modbus？ → Modbus TCP
做数据采集/MES对接/数字化转型？ → OPC UA
混合场景？ → OPC UA 做统一网关，底层按设备支持选择
```

实际项目中，我的做法是用一个**边缘网关**，把底层各种协议（Modbus、Profinet、OPC UA）统一转成 OPC UA 对上，这样 MES 和数据平台只需要对接一个协议。