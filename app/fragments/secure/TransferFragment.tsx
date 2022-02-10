import BN from 'bn.js';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleProp, Text, TextStyle, View, Image, KeyboardAvoidingView, Keyboard, Alert } from "react-native";
import { ScrollView, TouchableHighlight } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Address, Cell, CellMessage, CommentMessage, CommonMessageInfo, fromNano, InternalMessage, SendMode, toNano } from 'ton';
import { AndroidToolbar } from '../../components/AndroidToolbar';
import { ATextInput } from '../../components/ATextInput';
import { CloseButton } from '../../components/CloseButton';
import { RoundButton } from '../../components/RoundButton';
import { fragment } from "../../fragment";
import { Theme } from '../../Theme';
import { contractFromPublicKey } from '../../sync/contractFromPublicKey';
import { resolveUrl } from '../../utils/resolveUrl';
import { backoff } from '../../utils/time';
import { useTypedNavigation } from '../../utils/useTypedNavigation';
import { loadWalletKeys, WalletKeys } from '../../storage/walletKeys';
import { useRoute } from '@react-navigation/native';
import { useAccount } from '../../sync/Engine';
import { AsyncLock } from 'teslabot';
import { getCurrentAddress } from '../../storage/appState';
import { AppConfig } from '../../AppConfig';
import { fetchConfig } from '../../sync/fetchConfig';

const labelStyle: StyleProp<TextStyle> = {
    fontWeight: '600',
    marginLeft: 17,
    fontSize: 17
};

export const TransferFragment = fragment(() => {
    const { t } = useTranslation();
    const navigation = useTypedNavigation();
    const params: {
        target?: string,
        comment?: string | null,
        amount?: BN | null,
        payload?: Cell | null,
        stateInit?: Cell | null,
    } | undefined = useRoute().params;
    const [account, engine] = useAccount();
    const safeArea = useSafeAreaInsets();

    const [target, setTarget] = React.useState(params?.target || '');
    const [comment, setComment] = React.useState(params?.comment || '');
    const [amount, setAmount] = React.useState(params?.amount ? fromNano(params.amount) : '0');
    const [payload, setPayload] = React.useState<Cell | null>(params?.payload || null);
    const [stateInit, setStateInit] = React.useState<Cell | null>(params?.stateInit || null);
    const [estimation, setEstimation] = React.useState<BN | null>(null);
    const acc = React.useMemo(() => getCurrentAddress(), []);
    const doSend = React.useCallback(async () => {
        let address: Address;
        let value: BN;
        try {
            address = Address.parseFriendly(target).address;
            const validAmount = amount.replace(',', '.');
            value = toNano(validAmount);
        } catch (e) {
            return;
        }

        // Load contract
        const contract = await contractFromPublicKey(acc.publicKey);

        // Check if same address
        if (address.equals(contract.address)) {
            Alert.alert(t('You can\'t send coins to yourself'));
            return;
        }

        // Check amount
        if (!value.eq(account.balance) && account.balance.lt(value)) {
            Alert.alert(t('Unfortunatelly you don\'t have enougth coins for this transaction'));
            return;
        }
        if (value.eq(new BN(0))) {
            Alert.alert(t('Unfortunatelly you can\'t send zero coins'));
            return;
        }

        // Check against config
        const config = await backoff(() => fetchConfig());
        for (let restricted of config.wallets.restrict_send) {
            if (Address.parse(restricted).equals(address)) {
                Alert.alert(t('This address can\'t receive payments. Please, check your input and try again'));
                return;
            }
        }

        // Read key
        let walletKeys: WalletKeys;
        try {
            walletKeys = await loadWalletKeys(acc.secretKeyEnc);
        } catch (e) {
            navigation.goBack();
            return;
        }

        // Create transfer
        let transfer = await contract.createTransfer({
            seqno: account.seqno,
            walletId: contract.source.walletId,
            secretKey: walletKeys.keyPair.secretKey,
            sendMode: value.eq(account.balance)
                ? SendMode.CARRRY_ALL_REMAINING_BALANCE
                : SendMode.IGNORE_ERRORS | SendMode.PAY_GAS_SEPARATLY,
            order: new InternalMessage({
                to: address,
                value: value.eq(account.balance) ? toNano('0') : value,
                bounce: false,
                body: new CommonMessageInfo({
                    stateInit: stateInit ? new CellMessage(stateInit) : null,
                    body: payload ? new CellMessage(payload) : new CommentMessage(comment)
                })
            })
        });

        // Resolve fees
        const fee = await backoff(() => engine.connector.estimateExternalMessageFee(contract, transfer));

        // Sending transfer
        await backoff(() => engine.connector.client.sendExternalMessage(contract, transfer));

        // Notify
        engine.registerPending({
            id: 'pending-' + account.seqno,
            lt: null,
            fees: fee,
            amount: value.mul(new BN(-1)),
            address,
            seqno: account.seqno,
            kind: 'out',
            body: null,
            status: 'pending',
            time: Math.floor(Date.now() / 1000)
        });

        // Dismiss keyboard for iOS
        if (Platform.OS === 'ios') {
            Keyboard.dismiss();
        }

        // Reset stack to root
        navigation.popToTop();
    }, [amount, target, comment, account.seqno, payload, stateInit]);

    // Estimate fee
    const lock = React.useMemo(() => {
        return new AsyncLock();
    }, []);
    React.useEffect(() => {
        let ended = false;
        lock.inLock(async () => {
            await backoff(async () => {
                if (ended) {
                    return;
                }

                // Load app state
                const appState = getCurrentAddress();
                if (!appState) {
                    return;
                }

                // Parse address and value
                let address: Address;
                let value: BN;
                try {
                    address = Address.parseFriendly(target).address;
                    value = toNano(amount);
                } catch (e) {
                    address = appState.address;
                    value = new BN(0);
                }

                // Load contract
                const contract = await contractFromPublicKey(appState.publicKey);
                if (ended) {
                    return;
                }

                // Create transfer
                let transfer = await contract.createTransfer({
                    seqno: account.seqno,
                    walletId: contract.source.walletId,
                    secretKey: null,
                    sendMode: SendMode.IGNORE_ERRORS | SendMode.PAY_GAS_SEPARATLY,
                    order: new InternalMessage({
                        to: address,
                        value,
                        bounce: false,
                        body: new CommonMessageInfo({
                            stateInit: stateInit ? new CellMessage(stateInit) : null,
                            body: payload ? new CellMessage(payload) : new CommentMessage(comment)
                        })
                    })
                });
                if (ended) {
                    return;
                }

                // Check fees
                const fee = await engine.connector.estimateExternalMessageFee(contract, transfer);
                if (ended) {
                    return;
                }
                setEstimation(fee);
            });
        });
        return () => {
            ended = true;
        }
    }, [amount, target, comment, account.seqno, payload, stateInit]);

    const onQRCodeRead = React.useCallback((src: string) => {
        let res = resolveUrl(src);
        if (res) {
            setTarget(res.address.toFriendly({ testOnly: AppConfig.isTestnet }));
            if (res.amount) {
                setAmount(fromNano(res.amount));
            }
            if (res.comment) {
                setComment(res.comment);
            }
            if (res.payload) {
                setPayload(res.payload);
            } else {
                setPayload(null);
            }
            if (res.stateInit) {
                setStateInit(res.stateInit);
            } else {
                setStateInit(null);
            }
        }
    }, []);

    const onAddAll = React.useCallback(() => {
        setAmount(fromNano(account.balance));
    }, [setAmount, account]);

    return (
        <>
            <AndroidToolbar style={{ marginTop: safeArea.top }} pageTitle={t("Send Toncoin")} />
            <KeyboardAvoidingView
                behavior={Platform.OS === "ios" ? "padding" : "height"}
                style={{ flexGrow: 1 }}
                keyboardVerticalOffset={16}
            >
                <StatusBar style="dark" />
                {Platform.OS === 'ios' && (
                    <View style={{
                        paddingTop: 12,
                        paddingBottom: 17
                    }}>
                        <Text style={[labelStyle, { textAlign: 'center' }]}>{t(payload ? "Action" : "Send Toncoin")}</Text>
                    </View>
                )}
                <ScrollView
                    style={{ paddingHorizontal: 16, flex: 1 }}
                >
                    {payload && (
                        <View style={{
                            marginBottom: 14,
                            backgroundColor: "white",
                            borderRadius: 14,
                            justifyContent: 'center',
                            paddingHorizontal: 16,
                            paddingVertical: 19
                        }}>
                            <Text style={{
                                fontWeight: '400',
                                fontSize: 16,
                                color: '#8E979D'
                            }}>
                                {t('Amount')}
                            </Text>
                            <Text style={{
                                fontWeight: '800',
                                fontSize: 38,
                                color: Theme.accent,
                                marginTop: 4
                            }}>
                                {amount}
                            </Text>
                        </View>
                    )}
                    {!payload && (
                        <>
                            <View style={{
                                marginBottom: 16,
                                backgroundColor: "white",
                                borderRadius: 14,
                                justifyContent: 'center',
                                alignItems: 'center',
                                padding: 22
                            }}>
                                <ATextInput
                                    value={amount}
                                    onValueChange={setAmount}
                                    placeholder={t("Amount")}
                                    keyboardType={'numeric'}
                                    textAlign={'center'}
                                    style={{ marginBottom: 20, backgroundColor: 'transparent' }}
                                    fontWeight={'800'}
                                    fontSize={38}
                                    lineHeight={41}
                                    preventDefaultHeight
                                    preventDefaultValuePadding
                                />
                                <Text style={{
                                    fontWeight: '600',
                                    fontSize: 16,
                                    color: '#6D6D71'
                                }}>
                                    {fromNano(account?.balance || new BN(0))} TON
                                </Text>
                            </View>
                            <View style={{ flexDirection: 'row' }} collapsable={false}>
                                <View style={{ flexGrow: 1, flexBasis: 0, marginRight: 7, backgroundColor: 'white', borderRadius: 14 }}>
                                    <TouchableHighlight onPress={onAddAll} underlayColor={Theme.selector} style={{ borderRadius: 14 }}>
                                        <View style={{ justifyContent: 'center', alignItems: 'center', height: 66, borderRadius: 14 }}>
                                            <View style={{ backgroundColor: Theme.accent, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}>
                                                <Image source={require('../../../assets/ic_all_coins.png')} />
                                            </View>
                                            <Text style={{ fontSize: 13, color: Theme.accentText, marginTop: 4 }}>{t("Send all")}</Text>
                                        </View>
                                    </TouchableHighlight>
                                </View>
                                <View style={{ flexGrow: 1, flexBasis: 0, marginLeft: 7, backgroundColor: 'white', borderRadius: 14 }}>
                                    <TouchableHighlight onPress={() => navigation.navigate('Scanner', { callback: onQRCodeRead })} underlayColor={Theme.selector} style={{ borderRadius: 14 }}>
                                        <View style={{ justifyContent: 'center', alignItems: 'center', height: 66, borderRadius: 14 }}>
                                            <View style={{ backgroundColor: Theme.accent, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}>
                                                <Image source={require('../../../assets/ic_scan_qr.png')} />
                                            </View>
                                            <Text style={{ fontSize: 13, color: Theme.accentText, marginTop: 4 }}>{t("Scan QR code")}</Text>
                                        </View>
                                    </TouchableHighlight>
                                </View>
                            </View>
                            <Text style={{ fontWeight: '700', fontSize: 20, marginTop: 13 }}>{t("Send to")}</Text>
                        </>
                    )}
                    <View style={{
                        marginBottom: 16, marginTop: payload ? 0 : 17,
                        backgroundColor: "white",
                        borderRadius: 14,
                        justifyContent: 'center',
                        alignItems: 'center',
                    }}>
                        {payload && (
                            <Text style={{
                                fontWeight: '400',
                                fontSize: 16,
                                color: '#8E979D',
                                alignSelf: 'flex-start',
                                marginTop: 10,
                                marginLeft: 16
                            }}>
                                {t('Wallet adress')}
                            </Text>
                        )}
                        <ATextInput
                            value={target}
                            onValueChange={setTarget}
                            placeholder={t("Wallet adress")}
                            keyboardType="ascii-capable"
                            preventDefaultHeight
                            multiline
                            inputStyle={payload ? { paddingTop: 4 } : undefined}
                            style={{ backgroundColor: 'transparent', paddingHorizontal: 0, marginHorizontal: 16 }}
                            enabled={!payload}
                            editable={!payload}
                        />
                        <View style={{ height: 1, alignSelf: 'stretch', backgroundColor: Theme.divider, marginLeft: 16 }} />
                        {payload && (
                            <Text style={{
                                fontWeight: '400',
                                fontSize: 16,
                                color: '#8E979D',
                                alignSelf: 'flex-start',
                                marginTop: 10,
                                marginLeft: 16
                            }}>
                                {t('Purpose of transaction')}
                            </Text>
                        )}
                        <ATextInput
                            value={comment}
                            onValueChange={setComment}
                            placeholder={t("Message to recipient (optional)")}
                            keyboardType="default"
                            autoCapitalize="sentences"
                            inputStyle={payload ? { paddingTop: 4 } : undefined}
                            style={{ backgroundColor: 'transparent', paddingHorizontal: 0, marginHorizontal: 16 }}
                            enabled={!payload}
                            editable={!payload}
                            preventDefaultHeight
                            multiline
                        />
                        {payload && (
                            <>
                                <View style={{ height: 1, alignSelf: 'stretch', backgroundColor: Theme.divider, marginLeft: 16 }} />
                                <Text style={{
                                    fontWeight: '400',
                                    fontSize: 16,
                                    color: '#8E979D',
                                    alignSelf: 'flex-start',
                                    marginTop: 10,
                                    marginLeft: 16
                                }}>
                                    {t('Fee')}
                                </Text>
                                <Text style={{
                                    fontWeight: '400',
                                    fontSize: 16,
                                    alignSelf: 'flex-start',
                                    marginLeft: 16,
                                    marginTop: 4,
                                    marginBottom: 10
                                }}>
                                    {estimation ? fromNano(estimation) : '...'}
                                </Text>
                            </>

                        )}
                    </View>
                    {!payload && (<Text style={{ color: '#6D6D71', marginLeft: 16, fontSize: 13 }}>Blockchain fees: {estimation ? fromNano(estimation) : '...'}</Text>)}
                </ScrollView>
                <View style={[
                    {
                        marginHorizontal: 16, marginTop: 16,
                        paddingBottom: safeArea.bottom + 16
                    },
                ]}>
                    <RoundButton
                        title={t("Send")}
                        action={doSend}
                    />
                </View>
                {Platform.OS === 'ios' && (
                    <CloseButton
                        style={{ position: 'absolute', top: 12, right: 10 }}
                        onPress={() => {
                            navigation.goBack();
                        }}
                    />
                )}
            </KeyboardAvoidingView>
        </>
    );
});