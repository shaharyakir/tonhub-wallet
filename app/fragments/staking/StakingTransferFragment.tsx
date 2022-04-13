import BN from 'bn.js';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import { Platform, StyleProp, Text, TextStyle, View, KeyboardAvoidingView, Keyboard, Alert, Pressable } from "react-native";
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboard } from '@react-native-community/hooks';
import Animated, { useSharedValue, useAnimatedRef, measure, scrollTo, runOnUI } from 'react-native-reanimated';
import { Address, Cell, fromNano, toNano } from 'ton';
import { AndroidToolbar } from '../../components/AndroidToolbar';
import { ATextInput } from '../../components/ATextInput';
import { CloseButton } from '../../components/CloseButton';
import { RoundButton } from '../../components/RoundButton';
import { fragment } from "../../fragment";
import { Theme } from '../../Theme';
import { useTypedNavigation } from '../../utils/useTypedNavigation';
import { useRoute } from '@react-navigation/native';
import { useAccount } from '../../sync/Engine';
import { getCurrentAddress } from '../../storage/appState';
import { AppConfig } from '../../AppConfig';
import { t } from '../../i18n/t';
import { PriceComponent } from '../../components/PriceComponent';
import { createWithdrawStakeCell } from '../../utils/createWithdrawStakeCommand';
import { StakingCycle } from "../../components/Staking/StakingCycle";
import { StakingCalcComponent } from '../../components/Staking/StakingCalcComponent';
import { PoolTransactionInfo } from '../../components/Staking/PoolTransactionInfo';
import { UnstakeBanner } from '../../components/Staking/UnstakeBanner';
import { parseAmountToBn, parseAmountToValidBN } from '../../utils/parseAmount';

const labelStyle: StyleProp<TextStyle> = {
    fontWeight: '600',
    fontSize: 17
};

export type ATextInputRef = {
    focus: () => void;
    blur: () => void;
}

export type TransferAction = 'deposit' | 'withdraw' | 'top_up';

export type StakingTransferParams = {
    target?: string,
    comment?: string | null,
    amount?: BN | null,
    lockAmount?: boolean,
    lockComment?: boolean,
    lockAddress?: boolean,
    action?: TransferAction
}

export const StakingTransferFragment = fragment(() => {
    const navigation = useTypedNavigation();
    const params: StakingTransferParams | undefined = useRoute().params;
    const [account, engine] = useAccount();
    const safeArea = useSafeAreaInsets();
    const pool = engine.products.stakingPool.useState();
    const member = pool?.member

    const [title, setTitle] = React.useState('');
    const [amount, setAmount] = React.useState('');
    const [notConfirmed, setNotConfirmed] = React.useState(true);
    const [minAmountWarn, setMinAmountWarn] = React.useState<string>();

    const onSetAmount = React.useCallback(
        (newAmount: string) => {
            setMinAmountWarn(undefined);
            setAmount(newAmount);
        }, []);

    const doContinue = React.useCallback(async () => {
        let address: Address;
        let value: BN;

        if (!params?.target) {
            Alert.alert(t('transfer.error.invalidAddress'));
            return;
        }

        try {
            let parsed = Address.parseFriendly(params.target);
            address = parsed.address;
        } catch (e) {
            Alert.alert(t('transfer.error.invalidAddress'));
            return;
        }

        try {
            value = parseAmountToBn(amount);
        } catch (e) {
            Alert.alert(t('transfer.error.invalidAmount'));
            return;
        }

        // Check min stake amount
        if (
            (params?.action === 'deposit' || params?.action === 'top_up')
            && value.lt(pool!.params.minStake)
        ) {
            setMinAmountWarn(
                t('products.staking.minAmountWarning',
                    { minAmount: fromNano(pool!.params.minStake) })
            );
            return;
        }

        // Check availible 
        if (params?.action === 'withdraw') {
            const availible = member
                ? member.balance.add(member.withdraw).add(member.pendingDeposit)
                : undefined;
            if (!availible || availible.lt(value)) {
                setMinAmountWarn(t('products.staking.transfer.notEnoughStaked'));
                return;
            }
        }

        // Add withdraw payload
        let payload;
        let transferAmount = value;
        if (params?.action === 'withdraw') {
            console.log('[doContinue]', 'with');
            payload = createWithdrawStakeCell(transferAmount);
            console.log('[doContinue]', 'payload');
            transferAmount = pool ? pool.params.withdrawFee.add(pool.params.receiptPrice) : toNano('0.2');
            console.log('[doContinue]', 'transferAmount');
        }

        // Check amount
        if ((transferAmount.eq(account.balance) || account.balance.lt(transferAmount))) {
            setMinAmountWarn(t('transfer.error.notEnoughCoins'));
            return;
        }

        if (transferAmount.eq(new BN(0))) {
            Alert.alert(t('transfer.error.zeroCoins'));
            return;
        }

        if (notConfirmed) {
            refs[0].current?.blur();
            setNotConfirmed(false);
            return;
        }

        // Dismiss keyboard for iOS
        if (Platform.OS === 'ios') {
            Keyboard.dismiss();
        }

        // Close Staking Transfer modal
        navigation.goBack();

        // Navigate to TransferFragment
        navigation.navigate('Transfer', {
            target: address.toFriendly({ testOnly: AppConfig.isTestnet }),
            comment: params?.comment,
            amount: transferAmount,
            payload: payload,
        });

    }, [notConfirmed, amount, params, member, pool]);

    //
    // Scroll state tracking
    //

    const [selectedInput, setSelectedInput] = React.useState(0);

    const refs = React.useMemo(() => {
        let r: React.RefObject<ATextInputRef>[] = [];
        for (let i = 0; i < 3; i++) {
            r.push(React.createRef());
        }
        return r;
    }, []);

    const keyboard = useKeyboard();
    const scrollRef = useAnimatedRef<Animated.ScrollView>();
    const containerRef = useAnimatedRef<View>();

    const scrollToInput = React.useCallback((index: number) => {
        'worklet';

        if (index === 0) {
            scrollTo(scrollRef, 0, 0, true);
            return;
        }

        let container = measure(containerRef);
        scrollTo(scrollRef, 0, Platform.OS === 'android' ? 400 : container.height, true);
        return;

    }, []);

    const keyboardHeight = useSharedValue(keyboard.keyboardShown ? keyboard.keyboardHeight : 0);
    React.useEffect(() => {
        keyboardHeight.value = keyboard.keyboardShown ? keyboard.keyboardHeight : 0;
    }, [keyboard.keyboardShown ? keyboard.keyboardHeight : 0, selectedInput]);

    const onFocus = React.useCallback((index: number) => {
        if (amount === '0') {
            setAmount('');
        }
        runOnUI(scrollToInput)(index);
        setSelectedInput(index);
        setNotConfirmed(true);
    }, [amount]);

    const onBlur = React.useCallback((index: number) => {
        setNotConfirmed(false);
    }, []);

    const onAddAll = React.useCallback(() => {
        onSetAmount(
            fromNano(
                (params?.action === 'withdraw')
                    ? !member
                        ? toNano(0)
                        : member.balance.add(member.withdraw).add(member.pendingDeposit)
                    : account?.balance || new BN(0)
            )
        );
    }, []);

    React.useEffect(() => {
        if (notConfirmed) {
            setTitle(
                params?.action === 'deposit'
                    ? t('products.staking.transfer.depositStakeTitle')
                    : params?.action === 'withdraw'
                        ? t('products.staking.transfer.withdrawStakeTitle')
                        : params?.action === 'top_up'
                            ? t('products.staking.transfer.topUpTitle')
                            : t('products.staking.title')
            );
        } else {
            setTitle(
                params?.action === 'deposit'
                    ? t('products.staking.transfer.depositStakeTitle')
                    : params?.action === 'withdraw'
                        ? t('products.staking.transfer.withdrawStakeConfirmTitle')
                        : params?.action === 'top_up'
                            ? t('products.staking.transfer.topUpConfirmTitle')
                            : t('products.staking.title')
            );
        }
    }, [notConfirmed, params?.action]);

    React.useLayoutEffect(() => {
        setTimeout(() => refs[0]?.current?.focus(), 100);
    }, []);

    return (
        <>
            <AndroidToolbar
                style={{ marginTop: safeArea.top }}
                pageTitle={title}
            />
            <StatusBar style={Platform.OS === 'ios' ? 'light' : 'dark'} />
            {Platform.OS === 'ios' && (
                <View style={{
                    paddingTop: 12,
                    paddingBottom: 17,
                }}>
                    <Text style={[labelStyle, { textAlign: 'center', lineHeight: 32 }]}>
                        {title}
                    </Text>
                </View>
            )}
            <Animated.ScrollView
                style={{ flexGrow: 1, flexBasis: 0, alignSelf: 'stretch', }}
                contentInset={{ bottom: keyboard.keyboardShown ? (keyboard.keyboardHeight - safeArea.bottom) : 0.1 /* Some weird bug on iOS */, top: 0.1 /* Some weird bug on iOS */ }}
                contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 16 }}
                contentInsetAdjustmentBehavior="never"
                keyboardShouldPersistTaps="always"
                automaticallyAdjustContentInsets={false}
                ref={scrollRef}
                scrollEventThrottle={16}
            >
                <View
                    ref={containerRef}
                    style={{ flexGrow: 1, flexBasis: 0, alignSelf: 'stretch', flexDirection: 'column' }}
                >
                    <>
                        <View style={{
                            marginBottom: 0,
                            backgroundColor: "white",
                            borderRadius: 14,
                            justifyContent: 'center',
                            alignItems: 'center',
                            padding: 15,
                        }}>
                            <View style={{
                                flexDirection: 'row',
                                width: '100%',
                                justifyContent: 'space-between'
                            }}>
                                <Text style={{
                                    fontWeight: '400',
                                    fontSize: 16,
                                    color: '#8E979D',
                                }}>
                                    {t('common.amount')}
                                </Text>
                                <Pressable onPress={() => {
                                    onAddAll();
                                }}>

                                    <Text style={{
                                        fontWeight: '600',
                                        fontSize: 16,
                                        color: '#6D6D71',
                                    }}>
                                        {fromNano(
                                            (params?.action === 'withdraw')
                                                ? !member
                                                    ? toNano(0)
                                                    : member.balance.add(member.withdraw).add(member.pendingDeposit)
                                                : account?.balance || new BN(0)
                                        )} TON
                                    </Text>
                                </Pressable>
                            </View>
                            <View style={{
                                width: '100%',
                            }}>
                                <ATextInput
                                    index={0}
                                    ref={refs[0]}
                                    onFocus={onFocus}
                                    value={amount}
                                    onValueChange={onSetAmount}
                                    placeholder={'0'}
                                    keyboardType={'numeric'}
                                    textAlign={'left'}
                                    style={{ paddingHorizontal: 0, backgroundColor: 'transparent', marginTop: 4 }}
                                    inputStyle={{ color: Theme.accent, flexGrow: 0, paddingTop: 0, width: '100%' }}
                                    fontWeight={'800'}
                                    fontSize={30}
                                    onBlur={onBlur}
                                    preventDefaultHeight
                                    preventDefaultLineHeight
                                    preventDefaultValuePadding
                                    blurOnSubmit={false}
                                />
                                <PriceComponent
                                    amount={parseAmountToValidBN(amount)}
                                    style={{
                                        backgroundColor: 'transparent',
                                        paddingHorizontal: 0
                                    }}
                                    textStyle={{ color: '#6D6D71', fontWeight: '400' }}
                                />
                            </View>
                        </View>
                        {!!minAmountWarn && (
                            <Text style={{
                                color: '#FF0000',
                                fontWeight: '400',
                                fontSize: 14,
                                marginTop: 10
                            }}>
                                {minAmountWarn}
                            </Text>
                        )}
                        {(params?.action === 'deposit' || params?.action === 'top_up') && (
                            <>
                                <StakingCalcComponent
                                    amount={amount}
                                    topUp={params?.action === 'top_up'}
                                    member={member}
                                />
                                <PoolTransactionInfo pool={pool} />
                            </>
                        )}
                        {params?.action === 'withdraw' && (
                            <>
                                <View style={{
                                    backgroundColor: 'white',
                                    borderRadius: 14,
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    paddingLeft: 16,
                                    marginTop: 14,
                                    marginBottom: 15
                                }}>
                                    <View style={{
                                        flexDirection: 'row', width: '100%',
                                        justifyContent: 'space-between', alignItems: 'center',
                                        paddingRight: 16,
                                        height: 55
                                    }}>
                                        <Text style={{
                                            fontSize: 16,
                                            color: '#7D858A'
                                        }}>
                                            {t('products.staking.info.withdrawFee')}
                                        </Text>
                                        <View style={{ justifyContent: 'center' }}>
                                            <Text style={{
                                                fontWeight: '400',
                                                fontSize: 16,
                                                color: Theme.textColor
                                            }}>
                                                {`${pool?.params.withdrawFee ? fromNano(pool?.params.withdrawFee) : '0.1'} TON`}
                                            </Text>
                                            <PriceComponent
                                                amount={pool ? pool.params.withdrawFee : toNano('0.1')}
                                                style={{
                                                    backgroundColor: 'transparent',
                                                    paddingHorizontal: 0, paddingVertical: 2,
                                                    alignSelf: 'flex-end'
                                                }}
                                                textStyle={{ color: '#6D6D71', fontWeight: '400' }}
                                            />
                                        </View>
                                    </View>
                                </View>
                                {!!pool && (
                                    <StakingCycle
                                        stakeUntil={pool.params.stakeUntil}
                                        style={{
                                            marginBottom: 15
                                        }}
                                        withdraw={params.action === 'withdraw'}
                                    />
                                )}
                                {!!member && !notConfirmed && (
                                    <UnstakeBanner amount={amount} member={member} />
                                )}
                            </>
                        )}
                    </>
                </View>
            </Animated.ScrollView>
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'position' : undefined}
                style={{
                    marginHorizontal: 16, marginTop: 16,
                    marginBottom: safeArea.bottom + 16,
                }}
                keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 16}
            >
                <RoundButton
                    title={
                        notConfirmed
                            ? t('common.continue')
                            : t('common.confirm')
                    }
                    action={doContinue}
                />
            </KeyboardAvoidingView>
            {
                Platform.OS === 'ios' && (
                    <CloseButton
                        style={{ position: 'absolute', top: 12, right: 10 }}
                        onPress={() => {
                            navigation.goBack();
                        }}
                    />
                )
            }
        </>
    );
});